const GF_ORDER = 255;
const GF_POLYNOMIAL = 0x11d;

const GF_EXP = new Uint8Array(GF_ORDER * 2);
const GF_LOG = new Uint8Array(256);

let fieldValue = 1;
for (let exponent = 0; exponent < GF_ORDER; exponent += 1) {
  GF_EXP[exponent] = fieldValue;
  GF_LOG[fieldValue] = exponent;
  fieldValue <<= 1;
  if ((fieldValue & 0x100) !== 0) fieldValue ^= GF_POLYNOMIAL;
}
for (let exponent = GF_ORDER; exponent < GF_EXP.length; exponent += 1) {
  GF_EXP[exponent] = GF_EXP[exponent - GF_ORDER];
}

export type CauchyDecodeResult = Readonly<{
  data: Uint8Array;
  recoveredDataErasures: number;
  availableParitySymbols: number;
}>;

/**
 * Builds a systematic [n, k] MDS code over GF(256).
 *
 * The generator is [I_k; C], where C[r,c] = 1 / (x_r + y_c),
 * y_c = c, x_r = k + r, and field addition is XOR. The x and y sets are
 * disjoint while n <= 256, so every square submatrix of C is nonsingular.
 */
export function encodeCauchyMds(dataInput: Uint8Array, paritySymbols: number): Uint8Array {
  const data = Uint8Array.from(dataInput);
  validateGeometry(data.length, paritySymbols);
  const codeword = new Uint8Array(data.length + paritySymbols);
  codeword.set(data);
  for (let parity = 0; parity < paritySymbols; parity += 1) {
    let value = 0;
    for (let column = 0; column < data.length; column += 1) {
      value ^= gfMultiply(cauchyCoefficient(data.length, parity, column), data[column]);
    }
    codeword[data.length + parity] = value;
  }
  return codeword;
}

/**
 * Recovers known erasures. Unknown substitutions are detected by the MDS
 * parity check and are then rejected by the caller's CRC; they are never
 * silently converted into source bytes.
 */
export function decodeCauchyMds(
  observedInput: readonly (number | null)[],
  dataSymbols: number,
): CauchyDecodeResult {
  const paritySymbols = observedInput.length - dataSymbols;
  validateGeometry(dataSymbols, paritySymbols);
  const observed = observedInput.map((value) => {
    if (value === null) return null;
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error("MDS symbol must be an octet or erasure");
    return value;
  });
  const missingData: number[] = [];
  const availableParity: number[] = [];
  for (let column = 0; column < dataSymbols; column += 1) {
    if (observed[column] === null) missingData.push(column);
  }
  for (let parity = 0; parity < paritySymbols; parity += 1) {
    if (observed[dataSymbols + parity] !== null) availableParity.push(parity);
  }
  if (missingData.length > availableParity.length) {
    throw new Error("MDS erasure budget exceeded");
  }

  const data = new Uint8Array(dataSymbols);
  for (let column = 0; column < dataSymbols; column += 1) {
    const value = observed[column];
    if (value !== null) data[column] = value;
  }
  if (missingData.length > 0) {
    const equations = availableParity.slice(0, missingData.length).map((parity) => {
      const coefficients = missingData.map((column) => cauchyCoefficient(dataSymbols, parity, column));
      let result = observed[dataSymbols + parity] as number;
      for (let column = 0; column < dataSymbols; column += 1) {
        const value = observed[column];
        if (value !== null) {
          result ^= gfMultiply(cauchyCoefficient(dataSymbols, parity, column), value);
        }
      }
      return { coefficients, result };
    });
    const recovered = solveFieldEquations(
      equations.map((equation) => equation.coefficients),
      equations.map((equation) => equation.result),
    );
    missingData.forEach((column, index) => {
      data[column] = recovered[index];
    });
  }

  const expected = encodeCauchyMds(data, paritySymbols);
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] !== null && observed[index] !== expected[index]) {
      throw new Error("MDS parity check detected an unknown symbol error");
    }
  }
  return {
    data,
    recoveredDataErasures: missingData.length,
    availableParitySymbols: availableParity.length,
  };
}

function cauchyCoefficient(dataSymbols: number, parity: number, column: number): number {
  return gfInverse((dataSymbols + parity) ^ column);
}

function solveFieldEquations(matrixInput: readonly (readonly number[])[], resultInput: readonly number[]): Uint8Array {
  const size = matrixInput.length;
  if (resultInput.length !== size || matrixInput.some((row) => row.length !== size)) {
    throw new Error("MDS recovery matrix must be square");
  }
  const matrix = matrixInput.map((row) => Uint8Array.from(row));
  const result = Uint8Array.from(resultInput);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    while (pivot < size && matrix[pivot][column] === 0) pivot += 1;
    if (pivot === size) throw new Error("MDS recovery matrix is singular");
    if (pivot !== column) {
      [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
      [result[column], result[pivot]] = [result[pivot], result[column]];
    }
    const inverse = gfInverse(matrix[column][column]);
    for (let cell = column; cell < size; cell += 1) matrix[column][cell] = gfMultiply(matrix[column][cell], inverse);
    result[column] = gfMultiply(result[column], inverse);
    for (let row = 0; row < size; row += 1) {
      if (row === column || matrix[row][column] === 0) continue;
      const factor = matrix[row][column];
      for (let cell = column; cell < size; cell += 1) {
        matrix[row][cell] ^= gfMultiply(factor, matrix[column][cell]);
      }
      result[row] ^= gfMultiply(factor, result[column]);
    }
  }
  return result;
}

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function gfInverse(value: number): number {
  if (value === 0) throw new Error("zero has no multiplicative inverse in GF(256)");
  return GF_EXP[GF_ORDER - GF_LOG[value]];
}

function validateGeometry(dataSymbols: number, paritySymbols: number) {
  if (!Number.isInteger(dataSymbols) || dataSymbols <= 0) throw new Error("MDS data symbol count must be positive");
  if (!Number.isInteger(paritySymbols) || paritySymbols <= 0) throw new Error("MDS parity symbol count must be positive");
  if (dataSymbols + paritySymbols > 256) throw new Error("GF(256) Cauchy code length cannot exceed 256 symbols");
}

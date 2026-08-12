import { describe, expect, it } from "vitest";

import { decodeCauchyMds, encodeCauchyMds } from "../src/lib/cauchy-erasure";

function fixture(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 73 + 19) & 0xff);
}

describe("systematic Cauchy MDS erasure code", () => {
  it("preserves the source prefix and deterministically appends parity", () => {
    const source = fixture(210);
    const first = encodeCauchyMds(source, 40);
    const second = encodeCauchyMds(source, 40);

    expect(first).toHaveLength(250);
    expect(Array.from(first.subarray(0, source.length))).toEqual(Array.from(source));
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(Array.from(first.subarray(source.length)).some((value) => value !== 0)).toBe(true);
  });

  it("recovers forty erased source octets when all parity is present", () => {
    const source = fixture(210);
    const observed: Array<number | null> = Array.from(encodeCauchyMds(source, 40));
    for (let index = 0; index < 40; index += 1) observed[(index * 47) % source.length] = null;

    const decoded = decodeCauchyMds(observed, source.length);

    expect(decoded.recoveredDataErasures).toBe(40);
    expect(Array.from(decoded.data)).toEqual(Array.from(source));
  });

  it("recovers mixed source and parity erasures within the remaining equation budget", () => {
    const source = fixture(210);
    const observed: Array<number | null> = Array.from(encodeCauchyMds(source, 40));
    for (let index = 0; index < 25; index += 1) observed[(index * 29) % source.length] = null;
    for (let index = 0; index < 15; index += 1) observed[source.length + index] = null;

    const decoded = decodeCauchyMds(observed, source.length);

    expect(decoded.recoveredDataErasures).toBe(25);
    expect(decoded.availableParitySymbols).toBe(25);
    expect(Array.from(decoded.data)).toEqual(Array.from(source));
  });

  it("rejects erasures beyond the MDS budget", () => {
    const source = fixture(210);
    const observed: Array<number | null> = Array.from(encodeCauchyMds(source, 40));
    for (let index = 0; index < 41; index += 1) observed[index] = null;

    expect(() => decodeCauchyMds(observed, source.length)).toThrow("budget");
  });

  it("detects an unmarked symbol substitution", () => {
    const source = fixture(210);
    const observed: Array<number | null> = Array.from(encodeCauchyMds(source, 40));
    observed[17] = (observed[17] as number) ^ 0x80;

    expect(() => decodeCauchyMds(observed, source.length)).toThrow("unknown symbol error");
  });
});

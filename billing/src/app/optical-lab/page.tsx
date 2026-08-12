import type { Metadata } from "next";

import { OpticalLab } from "./optical-lab";

export const metadata: Metadata = {
  title: "Prism Native Dynamic Optical Field Lab",
  description: "A borderless 2,040-cell balanced-aspect affine-triangular dynamic multicolor field with robust camera sampling, adaptive 8/16/24/32-state modulation, MDS inner FEC, and RFC 6330 RaptorQ repair.",
};

export default async function OpticalLabPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role } = await searchParams;
  return <OpticalLab initialRole={role === "reader" ? "reader" : "sender"} />;
}

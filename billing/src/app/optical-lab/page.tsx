import type { Metadata } from "next";

import { OpticalLab } from "./optical-lab";

export const metadata: Metadata = {
  title: "Integrated Dynamic Color QR Lab",
  description: "A single QR-family matrix combining QR luminance geometry with an eight-state dynamic chroma payload.",
};

export default async function OpticalLabPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role } = await searchParams;
  return <OpticalLab initialRole={role === "reader" ? "reader" : "sender"} />;
}

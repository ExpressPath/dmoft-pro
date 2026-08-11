import type { Metadata } from "next";

import { OpticalLab } from "./optical-lab";

export const metadata: Metadata = {
  title: "PrismGlyph Dynamic Camera Lab",
  description: "PC display to phone camera test for a startless dynamic C6 optical stream with systematic and XOR repair frames.",
};

export default async function OpticalLabPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role } = await searchParams;
  return <OpticalLab initialRole={role === "reader" ? "reader" : "sender"} />;
}

import type { Metadata } from "next";

import { OpticalLab } from "./optical-lab";

export const metadata: Metadata = {
  title: "DMOFT Live Camera Lab",
  description: "PC display to phone camera optical reliability test for the DMOFT C4 web laboratory profile.",
};

export default async function OpticalLabPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role } = await searchParams;
  return <OpticalLab initialRole={role === "reader" ? "reader" : "sender"} />;
}

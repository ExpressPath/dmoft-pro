import type { Metadata } from "next";

import { OpticalLab } from "./optical-lab";

export const metadata: Metadata = {
  title: "Prism C16 Dynamic Optical Lab",
  description: "A custom 41 x 41 optical stream with four-finder geometry, sixteen-state color payloads, and triple-stripe error correction.",
};

export default async function OpticalLabPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role } = await searchParams;
  return <OpticalLab initialRole={role === "reader" ? "reader" : "sender"} />;
}

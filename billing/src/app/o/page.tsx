import { redirect } from "next/navigation";

export default function OpticalBootstrapPage() {
  redirect("/optical-lab?role=reader");
}

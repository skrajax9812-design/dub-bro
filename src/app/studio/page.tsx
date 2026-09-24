import type { Metadata } from "next";
import { Studio } from "@/components/studio/Studio";

export const metadata: Metadata = {
  title: "Studio — DUBFORGE",
  description: "Unlimited AI video dubbing studio. Any length, any language, no watermark.",
};

export default function StudioPage() {
  return <Studio />;
}

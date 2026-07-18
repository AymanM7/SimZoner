import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SimZoner — Predictive AV Routing & HOV Optimization",
  description:
    "Photorealistic map-based simulation of a Cybertruck, BMW M5, and Waymo across real Texas and Ohio interstate corridors, with a Vectorize-powered ML route predictor.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

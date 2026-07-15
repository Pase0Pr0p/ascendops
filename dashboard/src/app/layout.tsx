import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getDefaultBrand } from "@/lib/data/organization";
import "./globals.css";

// Body font — matches agenticpm.io / the classroom, which render body in Inter.
// Headings/display use CameraPlainVariable (self-hosted @font-face in globals.css).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

// Resolved at request time so metadata reflects the currently active brand
// without needing a dashboard rebuild when org context.json changes.
export async function generateMetadata(): Promise<Metadata> {
  const brand = getDefaultBrand();
  const descriptionSuffix = brand.isOrgBrand
    ? `${brand.name} agent orchestration dashboard`
    : "Agentic PM agent orchestration dashboard";
  return {
    title: `${brand.name} Dashboard`,
    description: descriptionSuffix,
    viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: brand.shortName,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <SessionProvider>
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
            <TooltipProvider>
              {children}
            </TooltipProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}

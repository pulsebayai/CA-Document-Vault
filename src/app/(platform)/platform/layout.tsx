import Link from "next/link";
import { signOut } from "@/lib/auth/actions";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { BrandMark } from "@/components/ui";

export const dynamic = "force-dynamic";

/** 19 (spec AC-3): the Platform area. Its own header: never a firm's name, nav or bell. */
export default async function PlatformLayout({ children }: LayoutProps<"/platform">) {
  const me = await requirePlatformAdmin();
  return (
    <>
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-white/[.92] px-4 backdrop-blur sm:px-6">
        <Link href="/platform" className="flex shrink-0 items-center gap-2.5">
          <BrandMark />
          <span className="leading-tight">
            <span className="block font-semibold">CA Document Vault</span>
            <span className="block text-xs text-ink-3">Platform{me.test ? " · test" : ""}</span>
          </span>
        </Link>
        <span className="ml-auto truncate text-[13.5px] text-ink-2">{me.fullName}</span>
        <form action={signOut}>
          <button type="submit" className="rounded-lg px-2.5 py-1.5 text-[13.5px] text-ink-2 hover:bg-line/50">Sign out</button>
        </form>
      </header>
      <main className="px-6 py-7">{children}</main>
    </>
  );
}

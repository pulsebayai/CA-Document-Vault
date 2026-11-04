import { loginBrand } from "@/lib/auth/login-brand";
import { PAUSED_MESSAGE, REMOVED_MESSAGE } from "@/lib/auth/access";
import { BrandMark, Card } from "@/components/ui";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { reason } = await searchParams;
  // 17: the platform name in multi mode (no database read); the deployment's one firm in single mode.
  const office = await loginBrand();
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-2.5">
          <BrandMark />
          <div>
            <p className="font-semibold leading-tight">{office.name}</p>
            {office.branch && <p className="text-[13px] text-ink-3">{office.branch}</p>}
          </div>
        </div>
        <Card className="p-6">
          <h1 className="text-[22px] font-semibold">Sign in</h1>
          <p className="mt-1 text-ink-2">We&apos;ll email you a sign-in link and code. No password needed.</p>
          {(reason === "removed" || reason === "paused") && (
            <p role="alert" className="mt-4 rounded-lg bg-bad-soft px-3 py-2 text-[13.5px] text-bad">
              {reason === "paused" ? PAUSED_MESSAGE : REMOVED_MESSAGE}
            </p>
          )}
          <LoginForm />
        </Card>
      </div>
    </main>
  );
}

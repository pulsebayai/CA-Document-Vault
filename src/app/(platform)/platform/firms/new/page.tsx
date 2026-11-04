import { createFirm } from "@/lib/platform/actions";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { Card, PageHeader } from "@/components/ui";
import { Back } from "../../ui";
import { FirmForm } from "./firm-form";

export const dynamic = "force-dynamic";

/** 19 (spec Y7, AC-5): create a firm (catalogue, financial years, preferred formats) and invite its first Admin. */
export default async function NewFirmPage() {
  const me = await requirePlatformAdmin();
  return (
    <div className="mx-auto max-w-[760px]">
      <Back href="/platform">Firms</Back>
      <PageHeader title="New firm" subtitle="The firm gets the standard catalogue. Its first Admin is emailed an invite and adds everyone else." />
      <Card className="p-6">
        <FirmForm action={createFirm} test={me.test} />
      </Card>
    </div>
  );
}

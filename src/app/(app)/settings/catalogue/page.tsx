import { requireStaff } from "@/lib/auth/staff";
import { canAddFinancialYear, canManageCatalogue } from "@/lib/auth/roles";
import { loadCatalogue, loadProposalQueue } from "@/lib/catalogue/queries";
import { CatalogueView } from "./catalogue-view";

/** Mockup 05-settings-catalogue.jpg. Everyone reads (AC-6); Admin/Manager edit; Admin adds FYs (AC-5). */
export default async function CataloguePage() {
  const me = await requireStaff();
  const canEdit = canManageCatalogue(me.role);
  // 05 AC-1: the "Proposed by staff" decision queue belongs to Admin/Manager (proposal_queue refuses everyone else).
  const [catalogue, proposed] = await Promise.all([loadCatalogue(), canEdit ? loadProposalQueue() : Promise.resolve(undefined)]);
  return <CatalogueView catalogue={catalogue} canEdit={canEdit} canAddFy={canAddFinancialYear(me.role)} proposed={canEdit ? proposed : undefined} />;
}

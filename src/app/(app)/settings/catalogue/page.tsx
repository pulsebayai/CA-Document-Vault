import { requireStaff } from "@/lib/auth/staff";
import { canAddFinancialYear, canManageCatalogue } from "@/lib/auth/roles";
import { loadCatalogue, loadProposedTypes } from "@/lib/catalogue/queries";
import { CatalogueView } from "./catalogue-view";

/** Mockup 05-settings-catalogue.jpg. Everyone reads (AC-6); Admin/Manager edit; Admin adds FYs (AC-5). */
export default async function CataloguePage() {
  const me = await requireStaff();
  const canEdit = canManageCatalogue(me.role);
  // AC-16: the "Proposed by staff" approval items belong to Admin/Manager (decisions arrive with 05).
  const [catalogue, proposed] = await Promise.all([loadCatalogue(), canEdit ? loadProposedTypes() : Promise.resolve([])]);
  return <CatalogueView catalogue={catalogue} canEdit={canEdit} canAddFy={canAddFinancialYear(me.role)} proposed={canEdit ? proposed : undefined} />;
}

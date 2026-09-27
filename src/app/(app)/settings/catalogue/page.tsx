import { requireStaff } from "@/lib/auth/staff";
import { canAddFinancialYear, canManageCatalogue } from "@/lib/auth/roles";
import { loadCatalogue } from "@/lib/catalogue/queries";
import { CatalogueView } from "./catalogue-view";

/** Mockup 05-settings-catalogue.jpg. Everyone reads (AC-6); Admin/Manager edit; Admin adds FYs (AC-5). */
export default async function CataloguePage() {
  const me = await requireStaff();
  const catalogue = await loadCatalogue();
  return <CatalogueView catalogue={catalogue} canEdit={canManageCatalogue(me.role)} canAddFy={canAddFinancialYear(me.role)} />;
}

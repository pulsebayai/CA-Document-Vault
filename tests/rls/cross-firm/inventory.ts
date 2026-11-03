import { adminClient } from "../../support/db";

// Feature 18 (spec X1): the database's own object list, read with the service role.

export type Inventory = {
  tables: Array<{ name: string; rls: boolean; office_id: boolean; policies: string[]; anon: boolean; fks: Array<{ columns: string[]; references: string }> }>;
  views: Array<{ name: string; security_invoker: boolean; anon: boolean }>;
  functions: Array<{ schema: string; name: string; args: string; definer: boolean; trigger: boolean; anon: boolean; authenticated: boolean; service_role: boolean }>;
  realtime: string[];
  storage: { policies: number; public_buckets: string[] };
};

export async function inventory(): Promise<Inventory> {
  const { data, error } = await adminClient().rpc("test_schema_inventory");
  if (error) throw error;
  return data as Inventory;
}

export const fnKey = (f: { schema: string; name: string; args: string }) => `${f.schema}.${f.name}(${f.args})`;

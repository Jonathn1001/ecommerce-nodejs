import { PrismaClient } from "../src/generated/prisma";

// Idempotent seed: without it nobody can register (no USER role) and nobody can administer
// anything (no ADMIN grants). Run explicitly — `pnpm --filter @ecom/identity seed`.
const prisma = new PrismaClient();

const RESOURCES = [
  "catalog.product",
  "catalog.comment",
  "catalog.discount",
  "payment.refund",
];
const ADMIN_GRANTS: Array<[string, string]> = [
  ["catalog.product", "create"],
  ["catalog.product", "update"],
  ["catalog.product", "delete"],
  ["catalog.discount", "create"],
  // The gateway protects DELETE /comments/:id with (catalog.comment, delete); without this
  // grant nobody — not even ADMIN — can ever delete a comment.
  ["catalog.comment", "delete"],
  ["payment.refund", "create"],
];

async function main() {
  for (const name of ["USER", "ADMIN"])
    await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  for (const name of RESOURCES)
    await prisma.resource.upsert({ where: { name }, create: { name }, update: {} });

  const admin = await prisma.role.findUniqueOrThrow({ where: { name: "ADMIN" } });
  for (const [resourceName, action] of ADMIN_GRANTS) {
    const resource = await prisma.resource.findUniqueOrThrow({
      where: { name: resourceName },
    });
    await prisma.grant.upsert({
      where: {
        roleId_resourceId_action: { roleId: admin.id, resourceId: resource.id, action },
      },
      create: { roleId: admin.id, resourceId: resource.id, action },
      update: {},
    });
  }
  console.log("seeded roles, resources and ADMIN grants");
}

main()
  .finally(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

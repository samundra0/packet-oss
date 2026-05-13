/**
 * Migrate existing GpuProducts into GpuCategories
 *
 * Idempotent: safe to re-run. Creates categories from unique gpuFamily values,
 * assigns products, creates HAI scenarios per category, and moves services.
 *
 * Usage: npx tsx scripts/migrate-products-to-categories.ts [--dry-run]
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`[Migration] ${DRY_RUN ? "DRY RUN — no changes will be made" : "Starting product-to-category migration"}`);

  // 1. Get all products with their gpuFamily values and existing categories
  const products = await prisma.gpuProduct.findMany({
    where: { active: true },
    orderBy: { displayOrder: "asc" },
    include: { categories: { select: { id: true } } },
  });

  console.log(`[Migration] Found ${products.length} active products`);

  // 2. Collect unique families (null → "Other")
  const familyMap = new Map<string, typeof products>();
  for (const p of products) {
    const family = p.gpuFamily || "Other";
    if (!familyMap.has(family)) familyMap.set(family, []);
    familyMap.get(family)!.push(p);
  }

  console.log(`[Migration] Unique families: ${[...familyMap.keys()].join(", ")}`);

  // 3. For each family, create or find a category
  let order = 0;
  for (const [family, familyProducts] of familyMap) {
    const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    // Check if category already exists
    let category = await prisma.gpuCategory.findFirst({
      where: { OR: [{ name: family }, { slug }] },
    });

    if (category) {
      console.log(`[Migration] Category "${family}" already exists (id=${category.id}, scenario=${category.scenarioId || "none"})`);
    } else if (DRY_RUN) {
      console.log(`[Migration] Would create category: "${family}" (slug=${slug})`);
    } else {
      // Create category with HAI scenario
      let scenarioId: string | null = null;
      try {
        // Dynamic import to get the scenario creation function
        const { createCategoryScenario } = await import("../src/lib/scenarios");
        scenarioId = await createCategoryScenario(family, slug);
      } catch (err) {
        console.warn(`[Migration] Failed to create HAI scenario for "${family}":`, err);
      }

      category = await prisma.gpuCategory.create({
        data: {
          name: family,
          slug,
          description: `${family} GPU products`,
          scenarioId,
          displayOrder: order,
          active: true,
        },
      });
      console.log(`[Migration] Created category: "${family}" (id=${category.id}, scenario=${scenarioId || "pending"})`);
    }

    order += 10;

    // 4. Assign products to this category (many-to-many: connect)
    for (const p of familyProducts) {
      if (p.categories.some((c: { id: string }) => c.id === category?.id)) {
        console.log(`[Migration]   Product "${p.name}" already in category "${family}"`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`[Migration]   Would assign product "${p.name}" to category "${family}"`);
      } else if (category) {
        await prisma.gpuProduct.update({
          where: { id: p.id },
          data: { categories: { connect: { id: category.id } } },
        });
        console.log(`[Migration]   Assigned product "${p.name}" to category "${family}"`);

        // 5. Move service to category scenario (best-effort)
        if (p.serviceId && category.scenarioId) {
          try {
            const { assignServiceToScenario } = await import("../src/lib/hostedai");
            await assignServiceToScenario(p.serviceId, category.scenarioId);
            console.log(`[Migration]   Assigned service ${p.serviceId} to category scenario`);
          } catch (err) {
            console.warn(`[Migration]   Failed to assign service to scenario:`, err);
          }
        }
      }
    }
  }

  // Summary
  const categories = await prisma.gpuCategory.findMany({ include: { _count: { select: { products: true } } } });
  const uncategorized = await prisma.gpuProduct.count({ where: { categories: { none: {} }, active: true } });

  console.log("\n[Migration] Summary:");
  for (const cat of categories) {
    console.log(`  ${cat.name}: ${cat._count.products} products, scenario=${cat.scenarioId || "PENDING"}`);
  }
  if (uncategorized > 0) {
    console.log(`  Uncategorized: ${uncategorized} active products`);
  }
  console.log(`[Migration] ${DRY_RUN ? "DRY RUN complete" : "Migration complete"}`);
}

main()
  .catch((err) => {
    console.error("[Migration] Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

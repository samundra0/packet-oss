-- CreateTable: gpu_category for organizing GPU products by type (PA-115)
-- Each category maps 1:1 to an HAI scenario for scoped compatibility checks
CREATE TABLE `gpu_category` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `description` VARCHAR(191) NULL,
  `scenario_id` VARCHAR(191) NULL,
  `display_order` INT NOT NULL DEFAULT 0,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `icon` VARCHAR(191) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `gpu_category_name_key`(`name`),
  UNIQUE INDEX `gpu_category_slug_key`(`slug`),
  INDEX `gpu_category_active_idx`(`active`),
  INDEX `gpu_category_display_order_idx`(`display_order`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: many-to-many join table for GpuCategory <-> GpuProduct
-- Prisma implicit relation convention: columns A (category) and B (product)
CREATE TABLE `_GpuCategoryToGpuProduct` (
  `A` VARCHAR(191) NOT NULL,
  `B` VARCHAR(191) NOT NULL,

  UNIQUE INDEX `_GpuCategoryToGpuProduct_AB_unique`(`A`, `B`),
  INDEX `_GpuCategoryToGpuProduct_B_index`(`B`),
  CONSTRAINT `_GpuCategoryToGpuProduct_A_fkey` FOREIGN KEY (`A`) REFERENCES `gpu_category`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `_GpuCategoryToGpuProduct_B_fkey` FOREIGN KEY (`B`) REFERENCES `gpu_product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Drop old category_id FK column if it exists (from prior single-category schema)
-- Safe to run even if column doesn't exist on fresh installs
SET @dbname = DATABASE();
SET @tablename = 'gpu_product';
SET @columnname = 'category_id';
SET @fkname = 'gpu_product_category_id_fkey';
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  CONCAT('ALTER TABLE `', @tablename, '` DROP FOREIGN KEY `', @fkname, '`, DROP COLUMN `', @columnname, '`'),
  'SELECT 1'
));
PREPARE dropIfExists FROM @preparedStatement;
EXECUTE dropIfExists;
DEALLOCATE PREPARE dropIfExists;

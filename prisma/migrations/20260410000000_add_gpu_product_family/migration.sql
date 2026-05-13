-- AlterTable: Add gpu_family to gpu_product for grouping products in the launch modal filter (PA-105)
-- Value is auto-derived from the associated pool's gpu_model_type (e.g. "H100", "A100", "B200")
ALTER TABLE `gpu_product` ADD COLUMN `gpu_family` VARCHAR(191) NULL;

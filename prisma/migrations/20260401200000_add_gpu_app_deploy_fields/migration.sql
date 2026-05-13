-- AlterTable: Add deploy-with-recipe fields to gpu_app (HAI 2.2)
ALTER TABLE `gpu_app` ADD COLUMN `service_id` VARCHAR(191) NULL;
ALTER TABLE `gpu_app` ADD COLUMN `product_id` VARCHAR(191) NULL;
ALTER TABLE `gpu_app` ADD COLUMN `deployable` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `gpu_app` ADD COLUMN `recipe_slug` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `gpu_app_deployable_idx` ON `gpu_app`(`deployable`);

-- AddForeignKey
ALTER TABLE `gpu_app` ADD CONSTRAINT `gpu_app_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `gpu_product`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

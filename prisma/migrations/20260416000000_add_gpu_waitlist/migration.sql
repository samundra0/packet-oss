-- CreateTable: gpu_waitlist for tracking GPU waitlist signups (B200, etc.)
CREATE TABLE `gpu_waitlist` (
  `id` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NULL,
  `gpu` VARCHAR(191) NOT NULL,
  `use_case` VARCHAR(191) NULL,
  `expected_gpu_hours` VARCHAR(191) NULL,
  `source` VARCHAR(191) NULL,
  `ip` VARCHAR(191) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `gpu_waitlist_email_gpu_key`(`email`, `gpu`),
  INDEX `gpu_waitlist_gpu_idx`(`gpu`),
  INDEX `gpu_waitlist_created_at_idx`(`created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

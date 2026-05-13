-- CreateTable
CREATE TABLE `embargo_log` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ip` VARCHAR(45) NOT NULL,
    `country` VARCHAR(2) NULL,
    `action` VARCHAR(10) NOT NULL,
    `reason` VARCHAR(50) NOT NULL,
    `endpoint` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NULL,
    `userAgent` TEXT NULL,
    `cf_threat` INTEGER NULL,

    INDEX `embargo_log_timestamp_idx`(`timestamp`),
    INDEX `embargo_log_country_idx`(`country`),
    INDEX `embargo_log_action_idx`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

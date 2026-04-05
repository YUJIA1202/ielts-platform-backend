/*
  Warnings:

  - You are about to drop the column `subtype` on the `video` table. All the data in the column will be lost.
  - You are about to drop the column `task` on the `video` table. All the data in the column will be lost.
  - You are about to drop the column `vodFileId` on the `video` table. All the data in the column will be lost.
  - Added the required column `category` to the `Video` table without a default value. This is not possible if the table is not empty.
  - Added the required column `series` to the `Video` table without a default value. This is not possible if the table is not empty.
  - Added the required column `url` to the `Video` table without a default value. This is not possible if the table is not empty.
  - Made the column `duration` on table `video` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `question` ADD COLUMN `outline` TEXT NULL;

-- AlterTable
ALTER TABLE `submission` ADD COLUMN `adminComment` TEXT NULL,
    ADD COLUMN `ccScore` DOUBLE NULL,
    ADD COLUMN `graScore` DOUBLE NULL,
    ADD COLUMN `lrScore` DOUBLE NULL,
    ADD COLUMN `overallScore` DOUBLE NULL,
    ADD COLUMN `reviewFileUrl` VARCHAR(191) NULL,
    ADD COLUMN `reviewSubtype` VARCHAR(191) NULL,
    ADD COLUMN `reviewTask` VARCHAR(191) NULL,
    ADD COLUMN `taScore` DOUBLE NULL;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `banned` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `password` VARCHAR(191) NULL,
    ADD COLUMN `registrationIp` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `video` DROP COLUMN `subtype`,
    DROP COLUMN `task`,
    DROP COLUMN `vodFileId`,
    ADD COLUMN `category` VARCHAR(191) NOT NULL,
    ADD COLUMN `coverUrl` VARCHAR(191) NULL,
    ADD COLUMN `isFree` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `series` VARCHAR(191) NOT NULL,
    ADD COLUMN `seriesOrder` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `url` VARCHAR(191) NOT NULL,
    MODIFY `description` TEXT NULL,
    MODIFY `duration` INTEGER NOT NULL;

-- CreateTable
CREATE TABLE `LoginSession` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `token` TEXT NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VideoTrialLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `videoId` INTEGER NOT NULL,
    `date` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VideoTrialLog_userId_videoId_key`(`userId`, `videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Reflection` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `tags` VARCHAR(191) NULL,
    `submissionId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CorrectionCode` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `type` ENUM('TASK2', 'TASK1', 'ANY') NOT NULL,
    `isUsed` BOOLEAN NOT NULL DEFAULT false,
    `usedBy` INTEGER NULL,
    `usedAt` DATETIME(3) NULL,
    `usedInSubmissionId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CorrectionCode_code_key`(`code`),
    UNIQUE INDEX `CorrectionCode_usedInSubmissionId_key`(`usedInSubmissionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'other',
    `title` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EssayViewLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `essayId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EssayViewLog_userId_essayId_key`(`userId`, `essayId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QuestionViewLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `questionId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `QuestionViewLog_userId_questionId_key`(`userId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notice` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `date` VARCHAR(191) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `visible` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SiteConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(191) NOT NULL,
    `value` LONGTEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SiteConfig_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LoginSession` ADD CONSTRAINT `LoginSession_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VideoTrialLog` ADD CONSTRAINT `VideoTrialLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VideoTrialLog` ADD CONSTRAINT `VideoTrialLog_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `Video`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reflection` ADD CONSTRAINT `Reflection_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reflection` ADD CONSTRAINT `Reflection_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `Submission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CorrectionCode` ADD CONSTRAINT `CorrectionCode_usedBy_fkey` FOREIGN KEY (`usedBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CorrectionCode` ADD CONSTRAINT `CorrectionCode_usedInSubmissionId_fkey` FOREIGN KEY (`usedInSubmissionId`) REFERENCES `Submission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EssayViewLog` ADD CONSTRAINT `EssayViewLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EssayViewLog` ADD CONSTRAINT `EssayViewLog_essayId_fkey` FOREIGN KEY (`essayId`) REFERENCES `ModelEssay`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuestionViewLog` ADD CONSTRAINT `QuestionViewLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuestionViewLog` ADD CONSTRAINT `QuestionViewLog_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `Question`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

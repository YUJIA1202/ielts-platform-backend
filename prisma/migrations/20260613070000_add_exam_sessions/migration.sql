CREATE TABLE `ExamSession` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `primaryQuestionId` INTEGER NOT NULL,
  `secondaryQuestionId` INTEGER NULL,
  `mode` ENUM('SINGLE', 'MIXED') NOT NULL,
  `status` ENUM('IN_PROGRESS', 'COMPLETED', 'ABANDONED') NOT NULL DEFAULT 'IN_PROGRESS',
  `primaryAnswer` LONGTEXT NULL,
  `secondaryAnswer` LONGTEXT NULL,
  `durationSeconds` INTEGER NOT NULL,
  `elapsedSeconds` INTEGER NOT NULL DEFAULT 0,
  `currentPart` INTEGER NOT NULL DEFAULT 1,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `ExamSession_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `ExamSession_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ExamSession`
  ADD CONSTRAINT `ExamSession_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ExamSession`
  ADD CONSTRAINT `ExamSession_primaryQuestionId_fkey`
  FOREIGN KEY (`primaryQuestionId`) REFERENCES `Question`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ExamSession`
  ADD CONSTRAINT `ExamSession_secondaryQuestionId_fkey`
  FOREIGN KEY (`secondaryQuestionId`) REFERENCES `Question`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

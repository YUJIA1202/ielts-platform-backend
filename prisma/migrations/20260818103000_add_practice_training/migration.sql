-- Practice item bank, learner profile, attempts and topic statistics.
-- PracticeSession is operational state shared by review tabs and the future
-- Navigator entry point.

CREATE TABLE `PracticeItem` (
    `id` VARCHAR(191) NOT NULL,
    `tab` ENUM('LANGUAGE', 'THINKING') NOT NULL,
    `itemType` ENUM('ERROR_CORRECTION', 'MCQ', 'CLOZE', 'CHAIN_CLOZE', 'BREAK_LOCATE', 'CONCESSION_MATCH', 'REASON_FILTER', 'ORDERING', 'FUNCTION_ID', 'STANCE_ID') NOT NULL,
    `topic` VARCHAR(191) NULL,
    `questionSubtype` VARCHAR(191) NULL,
    `issueTypes` JSON NOT NULL,
    `difficulty` ENUM('BASIC', 'CORE', 'STRETCH') NOT NULL DEFAULT 'CORE',
    `stem` TEXT NOT NULL,
    `materials` JSON NOT NULL,
    `options` JSON NULL,
    `answerKey` JSON NOT NULL,
    `acceptableAnswers` JSON NULL,
    `judgePoints` JSON NOT NULL,
    `explanation` LONGTEXT NOT NULL,
    `sourceRefs` JSON NOT NULL,
    `status` ENUM('DRAFT', 'VALIDATED', 'LIVE', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    `stats` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `changelog` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PracticeItem_tab_status_idx`(`tab`, `status`),
    INDEX `PracticeItem_topic_questionSubtype_idx`(`topic`, `questionSubtype`),
    INDEX `PracticeItem_itemType_status_idx`(`itemType`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PracticeProfile` (
    `studentId` INTEGER NOT NULL,
    `issueCounters` JSON NOT NULL,
    `sourceEssays` JSON NOT NULL,
    `masteryFlags` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`studentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PracticeSession` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` INTEGER NOT NULL,
    `aiReviewId` INTEGER NULL,
    `mode` ENUM('TOPIC', 'ESSAY') NOT NULL,
    `tab` ENUM('LANGUAGE', 'THINKING') NOT NULL,
    `topic` VARCHAR(191) NULL,
    `questionSubtype` VARCHAR(191) NULL,
    `itemIds` JSON NOT NULL,
    `profileSnapshot` JSON NULL,
    `status` ENUM('ACTIVE', 'COMPLETED', 'ABANDONED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `PracticeSession_studentId_createdAt_idx`(`studentId`, `createdAt`),
    INDEX `PracticeSession_aiReviewId_idx`(`aiReviewId`),
    INDEX `PracticeSession_tab_status_idx`(`tab`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PracticeAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` INTEGER NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `answerPayload` JSON NOT NULL,
    `verdict` ENUM('CORRECT', 'PARTIAL', 'WRONG') NOT NULL,
    `judgedBy` ENUM('PROGRAM', 'LIST', 'MODEL', 'SELF', 'HUMAN') NOT NULL,
    `judgeRationale` TEXT NULL,
    `fixed` JSON NULL,
    `remaining` JSON NULL,
    `appealStatus` ENUM('NONE', 'PENDING', 'UPHELD', 'OVERTURNED') NOT NULL DEFAULT 'NONE',
    `appealReason` TEXT NULL,
    `appealResolution` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PracticeAttempt_studentId_createdAt_idx`(`studentId`, `createdAt`),
    INDEX `PracticeAttempt_sessionId_itemId_idx`(`sessionId`, `itemId`),
    INDEX `PracticeAttempt_itemId_verdict_idx`(`itemId`, `verdict`),
    INDEX `PracticeAttempt_appealStatus_idx`(`appealStatus`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TopicErrorStat` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `topic` VARCHAR(191) NOT NULL,
    `questionSubtype` VARCHAR(191) NOT NULL,
    `issueType` VARCHAR(191) NOT NULL,
    `frequency` INTEGER NOT NULL,
    `share` DOUBLE NOT NULL,
    `sourceVersion` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TopicErrorStat_topic_questionSubtype_issueType_key`(`topic`, `questionSubtype`, `issueType`),
    INDEX `TopicErrorStat_topic_questionSubtype_idx`(`topic`, `questionSubtype`),
    INDEX `TopicErrorStat_issueType_idx`(`issueType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PracticeProfile`
    ADD CONSTRAINT `PracticeProfile_studentId_fkey`
    FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PracticeSession`
    ADD CONSTRAINT `PracticeSession_studentId_fkey`
    FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `PracticeSession_aiReviewId_fkey`
    FOREIGN KEY (`aiReviewId`) REFERENCES `AiReview`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `PracticeAttempt`
    ADD CONSTRAINT `PracticeAttempt_studentId_fkey`
    FOREIGN KEY (`studentId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `PracticeAttempt_sessionId_fkey`
    FOREIGN KEY (`sessionId`) REFERENCES `PracticeSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `PracticeAttempt_itemId_fkey`
    FOREIGN KEY (`itemId`) REFERENCES `PracticeItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

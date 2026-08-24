-- Add a stable prompt identity without changing or removing the existing
-- Question/KnowledgeDocument relationships and public API contracts.
CREATE TABLE `CanonicalQuestion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `promptHash` VARCHAR(64) NOT NULL,
    `normalizedPrompt` LONGTEXT NOT NULL,
    `displayPrompt` LONGTEXT NOT NULL,
    `task` ENUM('TASK1', 'TASK2') NULL,
    `subtype` VARCHAR(191) NULL,
    `topic` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CanonicalQuestion_promptHash_key`(`promptHash`),
    INDEX `CanonicalQuestion_task_subtype_idx`(`task`, `subtype`),
    INDEX `CanonicalQuestion_topic_idx`(`topic`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Question` ADD COLUMN `canonicalQuestionId` INTEGER NULL;
ALTER TABLE `KnowledgeDocument` ADD COLUMN `canonicalQuestionId` INTEGER NULL;

CREATE INDEX `Question_canonicalQuestionId_idx` ON `Question`(`canonicalQuestionId`);
CREATE INDEX `KnowledgeDocument_canonicalQuestionId_idx` ON `KnowledgeDocument`(`canonicalQuestionId`);

ALTER TABLE `Question`
  ADD CONSTRAINT `Question_canonicalQuestionId_fkey`
  FOREIGN KEY (`canonicalQuestionId`) REFERENCES `CanonicalQuestion`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `KnowledgeDocument`
  ADD CONSTRAINT `KnowledgeDocument_canonicalQuestionId_fkey`
  FOREIGN KEY (`canonicalQuestionId`) REFERENCES `CanonicalQuestion`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

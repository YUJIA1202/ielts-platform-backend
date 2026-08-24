-- Preserve complete Excel reviews while representing their atomic findings and
-- many-to-many evidence anchors at essay, paragraph, sentence, and span scope.

ALTER TABLE `KnowledgeDocument`
    ADD COLUMN `questionId` INTEGER NULL;

CREATE TABLE `KnowledgeTextUnit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `documentId` INTEGER NOT NULL,
    `parentId` INTEGER NULL,
    `unitType` VARCHAR(191) NOT NULL,
    `stableKey` VARCHAR(191) NOT NULL,
    `versionId` VARCHAR(191) NULL,
    `ordinal` INTEGER NOT NULL,
    `paragraphIndex` INTEGER NULL,
    `sentenceIndex` INTEGER NULL,
    `text` LONGTEXT NOT NULL,
    `startOffset` INTEGER NULL,
    `endOffset` INTEGER NULL,
    `sourceSheet` VARCHAR(191) NULL,
    `sourceRow` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `KnowledgeTextUnit_documentId_stableKey_key`(`documentId`, `stableKey`),
    INDEX `KnowledgeTextUnit_documentId_unitType_idx`(`documentId`, `unitType`),
    INDEX `KnowledgeTextUnit_documentId_paragraphIndex_sentenceIndex_idx`(`documentId`, `paragraphIndex`, `sentenceIndex`),
    INDEX `KnowledgeTextUnit_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeAssessment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `documentId` INTEGER NOT NULL,
    `chunkId` INTEGER NULL,
    `primaryUnitId` INTEGER NULL,
    `sourceKey` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `dimension` VARCHAR(191) NULL,
    `score` DOUBLE NULL,
    `status` VARCHAR(191) NULL,
    `tags` JSON NULL,
    `rawFeedback` LONGTEXT NOT NULL,
    `sourceSheet` VARCHAR(191) NULL,
    `sourceRow` INTEGER NULL,
    `sourceColumn` VARCHAR(191) NULL,
    `rawJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `KnowledgeAssessment_documentId_sourceKey_key`(`documentId`, `sourceKey`),
    INDEX `KnowledgeAssessment_documentId_scope_dimension_idx`(`documentId`, `scope`, `dimension`),
    INDEX `KnowledgeAssessment_chunkId_idx`(`chunkId`),
    INDEX `KnowledgeAssessment_primaryUnitId_idx`(`primaryUnitId`),
    INDEX `KnowledgeAssessment_kind_idx`(`kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeAssessmentFinding` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assessmentId` INTEGER NOT NULL,
    `primaryUnitId` INTEGER NULL,
    `ordinal` INTEGER NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `feedbackStartOffset` INTEGER NULL,
    `feedbackEndOffset` INTEGER NULL,
    `confidence` DOUBLE NULL,
    `semanticStatus` VARCHAR(191) NOT NULL DEFAULT 'DETERMINISTIC',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `KnowledgeAssessmentFinding_assessmentId_ordinal_key`(`assessmentId`, `ordinal`),
    INDEX `KnowledgeAssessmentFinding_assessmentId_scope_idx`(`assessmentId`, `scope`),
    INDEX `KnowledgeAssessmentFinding_primaryUnitId_idx`(`primaryUnitId`),
    INDEX `KnowledgeAssessmentFinding_kind_idx`(`kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeAssessmentEvidence` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `findingId` INTEGER NOT NULL,
    `unitId` INTEGER NULL,
    `refKey` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL,
    `quotedText` LONGTEXT NULL,
    `startOffset` INTEGER NULL,
    `endOffset` INTEGER NULL,
    `locationStatus` ENUM('PENDING', 'RESOLVED', 'UNRESOLVED') NOT NULL DEFAULT 'PENDING',
    `confidence` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `KnowledgeAssessmentEvidence_findingId_idx`(`findingId`),
    INDEX `KnowledgeAssessmentEvidence_unitId_idx`(`unitId`),
    INDEX `KnowledgeAssessmentEvidence_refKey_idx`(`refKey`),
    INDEX `KnowledgeAssessmentEvidence_role_idx`(`role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeRewriteExample` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `documentId` INTEGER NOT NULL,
    `sourceUnitId` INTEGER NULL,
    `sourceKey` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `sourceType` VARCHAR(191) NOT NULL,
    `layers` JSON NULL,
    `originalText` LONGTEXT NOT NULL,
    `rewrittenText` LONGTEXT NOT NULL,
    `reason` LONGTEXT NULL,
    `sourceRefs` JSON NULL,
    `sourceSheet` VARCHAR(191) NULL,
    `sourceRow` INTEGER NULL,
    `sourceColumn` VARCHAR(191) NULL,
    `rawText` LONGTEXT NULL,
    `allowedForRag` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `KnowledgeRewriteExample_documentId_sourceKey_key`(`documentId`, `sourceKey`),
    INDEX `KnowledgeRewriteExample_documentId_scope_idx`(`documentId`, `scope`),
    INDEX `KnowledgeRewriteExample_sourceUnitId_idx`(`sourceUnitId`),
    INDEX `KnowledgeRewriteExample_sourceType_idx`(`sourceType`),
    INDEX `KnowledgeRewriteExample_allowedForRag_idx`(`allowedForRag`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `KnowledgeSourceRecord` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `documentId` INTEGER NOT NULL,
    `sourceKey` VARCHAR(191) NOT NULL,
    `sheetName` VARCHAR(191) NOT NULL,
    `rowIndex` INTEGER NULL,
    `recordType` VARCHAR(191) NOT NULL,
    `rawJson` JSON NOT NULL,
    `sourceHash` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `KnowledgeSourceRecord_documentId_sourceKey_key`(`documentId`, `sourceKey`),
    INDEX `KnowledgeSourceRecord_documentId_sheetName_idx`(`documentId`, `sheetName`),
    INDEX `KnowledgeSourceRecord_recordType_idx`(`recordType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `KnowledgeDocument_questionId_idx` ON `KnowledgeDocument`(`questionId`);

ALTER TABLE `KnowledgeDocument`
    ADD CONSTRAINT `KnowledgeDocument_questionId_fkey`
    FOREIGN KEY (`questionId`) REFERENCES `Question`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `KnowledgeTextUnit`
    ADD CONSTRAINT `KnowledgeTextUnit_documentId_fkey`
    FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `KnowledgeTextUnit_parentId_fkey`
    FOREIGN KEY (`parentId`) REFERENCES `KnowledgeTextUnit`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `KnowledgeAssessment`
    ADD CONSTRAINT `KnowledgeAssessment_documentId_fkey`
    FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `KnowledgeAssessment_chunkId_fkey`
    FOREIGN KEY (`chunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `KnowledgeAssessment_primaryUnitId_fkey`
    FOREIGN KEY (`primaryUnitId`) REFERENCES `KnowledgeTextUnit`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `KnowledgeAssessmentFinding`
    ADD CONSTRAINT `KnowledgeAssessmentFinding_assessmentId_fkey`
    FOREIGN KEY (`assessmentId`) REFERENCES `KnowledgeAssessment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `KnowledgeAssessmentFinding_primaryUnitId_fkey`
    FOREIGN KEY (`primaryUnitId`) REFERENCES `KnowledgeTextUnit`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `KnowledgeAssessmentEvidence`
    ADD CONSTRAINT `KnowledgeAssessmentEvidence_findingId_fkey`
    FOREIGN KEY (`findingId`) REFERENCES `KnowledgeAssessmentFinding`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `KnowledgeAssessmentEvidence_unitId_fkey`
    FOREIGN KEY (`unitId`) REFERENCES `KnowledgeTextUnit`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `KnowledgeRewriteExample`
    ADD CONSTRAINT `KnowledgeRewriteExample_documentId_fkey`
    FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `KnowledgeRewriteExample_sourceUnitId_fkey`
    FOREIGN KEY (`sourceUnitId`) REFERENCES `KnowledgeTextUnit`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `KnowledgeSourceRecord`
    ADD CONSTRAINT `KnowledgeSourceRecord_documentId_fkey`
    FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

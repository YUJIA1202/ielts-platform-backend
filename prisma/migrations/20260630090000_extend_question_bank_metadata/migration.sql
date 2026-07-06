ALTER TABLE `Question`
  ADD COLUMN `topicCategory` VARCHAR(191) NULL,
  ADD COLUMN `topicSubcategory` TEXT NULL,
  ADD COLUMN `sourceKey` VARCHAR(191) NULL,
  ADD COLUMN `sourceRow` INTEGER NULL,
  ADD COLUMN `examDate` DATETIME(3) NULL,
  ADD COLUMN `testMode` VARCHAR(191) NULL,
  ADD COLUMN `region` VARCHAR(191) NULL,
  ADD COLUMN `similarGroup` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `Question_sourceKey_key` ON `Question`(`sourceKey`);
CREATE INDEX `Question_task_subtype_idx` ON `Question`(`task`, `subtype`);
CREATE INDEX `Question_task_topicCategory_idx` ON `Question`(`task`, `topicCategory`);
CREATE INDEX `Question_year_month_idx` ON `Question`(`year`, `month`);
CREATE INDEX `Question_examDate_idx` ON `Question`(`examDate`);

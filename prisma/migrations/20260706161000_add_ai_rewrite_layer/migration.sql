-- Add product-facing rewrite layer labels for the AI review rewrite tab.
ALTER TABLE `AiRewrite` ADD COLUMN `rewriteLayer` ENUM('LANGUAGE', 'COHERENCE', 'TASK', 'PARAGRAPH') NULL;

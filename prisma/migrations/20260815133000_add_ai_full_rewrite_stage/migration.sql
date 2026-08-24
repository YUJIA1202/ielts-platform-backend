-- Persist the separately generated, non-mechanical full-essay reconstruction.
ALTER TABLE `AiReviewStageResult`
    MODIFY `stage` ENUM(
        'GLOBAL_ANALYSIS',
        'PARAGRAPH_ANALYSIS',
        'SENTENCE_ANALYSIS',
        'MERGE',
        'VERIFICATION',
        'REPAIR',
        'FULL_REWRITE'
    ) NOT NULL;

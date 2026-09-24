-- Quan hệ "nội dung mới THAY THẾ nội dung cũ" (yêu cầu §4.6): chỉ có khi người duyệt xác nhận, không bao giờ suy ra từ thời
-- điểm nhập. Lưu cùng bảng quyết định theo cặp, kèm bên được giữ (winner_key) vì quan hệ này có chiều.
ALTER TABLE kb_pair_decisions DROP CONSTRAINT IF EXISTS kb_pair_decisions_decision_check;
ALTER TABLE kb_pair_decisions ADD CONSTRAINT kb_pair_decisions_decision_check CHECK (decision IN ('distinct', 'keep_both', 'merged', 'fixed', 'supersedes'));
ALTER TABLE kb_pair_decisions ADD COLUMN winner_key text;

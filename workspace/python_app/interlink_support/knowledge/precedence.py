from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .models import ActiveVersionSnapshot, ResolutionAction, ResolutionDecision


@dataclass(frozen=True, slots=True)
class CandidateFacts:
    content_hash: str
    source_priority: int
    effective_from: datetime | None
    uploaded_at: datetime
    identity_confidence: float


def decide_precedence(
    active: ActiveVersionSnapshot | None,
    candidate: CandidateFacts,
    *,
    identity_min_confidence: float,
) -> ResolutionDecision:
    """Deterministic precedence.

    Thứ tự: identity certainty -> duplicate -> source authority -> effective time -> uploaded time.
    Timestamp upload chỉ là fallback, không được thắng một nguồn authoritative hơn hoặc một effective date mới hơn.
    """

    if candidate.identity_confidence < identity_min_confidence:
        return ResolutionDecision(
            action=ResolutionAction.CONFLICT,
            reason=(
                f"identity confidence {candidate.identity_confidence:.3f} < "
                f"minimum {identity_min_confidence:.3f}; fail closed"
            ),
        )

    if active is None:
        return ResolutionDecision(
            action=ResolutionAction.NEW_ACTIVE,
            reason="không có active version cùng identity/scope",
        )

    if candidate.content_hash == active.content_hash:
        return ResolutionDecision(action=ResolutionAction.DUPLICATE, reason="content hash trùng active version")

    if candidate.source_priority > active.source_priority:
        return ResolutionDecision(
            action=ResolutionAction.SUPERSEDE,
            reason=f"source priority mới {candidate.source_priority} > active {active.source_priority}",
        )

    if candidate.source_priority < active.source_priority:
        return ResolutionDecision(
            action=ResolutionAction.SHADOW,
            reason=f"source priority mới {candidate.source_priority} < active {active.source_priority}",
        )

    # Cùng authority: effective_from là mốc nghiệp vụ, ưu tiên hơn thời điểm upload.
    if candidate.effective_from is not None and active.effective_from is not None:
        if candidate.effective_from > active.effective_from:
            return ResolutionDecision(action=ResolutionAction.SUPERSEDE, reason="effective_from mới hơn active")
        if candidate.effective_from < active.effective_from:
            return ResolutionDecision(action=ResolutionAction.SHADOW, reason="effective_from cũ hơn active")

    # Nếu chỉ candidate có effective date, coi đó là bằng chứng version có mốc nghiệp vụ rõ hơn.
    if candidate.effective_from is not None and active.effective_from is None:
        return ResolutionDecision(
            action=ResolutionAction.SUPERSEDE,
            reason="candidate có effective_from rõ ràng, active không có",
        )

    # Nếu active có effective date nhưng candidate không có, upload mới không được ghi đè mù quáng policy đã định ngày.
    if candidate.effective_from is None and active.effective_from is not None:
        return ResolutionDecision(action=ResolutionAction.SHADOW, reason="active có effective_from, candidate không có")

    # Controlled latest-wins fallback: cùng authority và không có mốc nghiệp vụ phân biệt.
    if candidate.uploaded_at > active.uploaded_at:
        return ResolutionDecision(
            action=ResolutionAction.SUPERSEDE,
            reason="fallback latest-upload-wins cùng authority",
        )
    if candidate.uploaded_at < active.uploaded_at:
        return ResolutionDecision(
            action=ResolutionAction.SHADOW,
            reason="candidate upload cũ hơn active cùng authority",
        )

    return ResolutionDecision(
        action=ResolutionAction.CONFLICT,
        reason="cùng authority, cùng effective/upload time nhưng nội dung khác; không đủ căn cứ chọn winner",
    )

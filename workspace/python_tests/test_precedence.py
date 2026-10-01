from datetime import UTC, datetime, timedelta
from uuid import uuid4

from interlink_support.knowledge.models import ActiveVersionSnapshot, KnowledgeStatus, ResolutionAction
from interlink_support.knowledge.precedence import CandidateFacts, decide_precedence

NOW = datetime(2026, 10, 1, tzinfo=UTC)


def active(
    *,
    content_hash: str = "old",
    priority: int = 50,
    effective: datetime | None = None,
    uploaded: datetime = NOW,
) -> ActiveVersionSnapshot:
    return ActiveVersionSnapshot(
        id=uuid4(),
        knowledge_unit_id=uuid4(),
        source_id=uuid4(),
        version_number=1,
        status=KnowledgeStatus.ACTIVE,
        content="old answer",
        canonical_title="Forgot ID",
        canonical_summary="old",
        keywords=[],
        language="en",
        source_priority=priority,
        effective_from=effective,
        uploaded_at=uploaded,
        content_hash=content_hash,
        generation=1,
    )


def candidate(
    *,
    content_hash: str = "new",
    priority: int = 50,
    effective: datetime | None = None,
    uploaded: datetime = NOW + timedelta(hours=1),
    confidence: float = 1,
) -> CandidateFacts:
    return CandidateFacts(
        content_hash=content_hash,
        source_priority=priority,
        effective_from=effective,
        uploaded_at=uploaded,
        identity_confidence=confidence,
    )


def decide(a: ActiveVersionSnapshot | None, c: CandidateFacts):
    return decide_precedence(a, c, identity_min_confidence=0.78)


def test_new_identity_becomes_active():
    assert decide(None, candidate()).action == ResolutionAction.NEW_ACTIVE


def test_exact_duplicate_does_not_create_new_active():
    assert decide(active(content_hash="same"), candidate(content_hash="same")).action == ResolutionAction.DUPLICATE


def test_higher_authority_supersedes_even_without_date():
    assert decide(active(priority=50), candidate(priority=90)).action == ResolutionAction.SUPERSEDE


def test_lower_authority_never_wins_by_upload_time():
    c = candidate(priority=20, uploaded=NOW + timedelta(days=100))
    assert decide(active(priority=90), c).action == ResolutionAction.SHADOW


def test_newer_effective_date_supersedes():
    old_date = NOW - timedelta(days=30)
    new_date = NOW
    assert decide(active(effective=old_date), candidate(effective=new_date)).action == ResolutionAction.SUPERSEDE


def test_older_document_uploaded_later_does_not_supersede():
    a = active(effective=NOW)
    c = candidate(effective=NOW - timedelta(days=60), uploaded=NOW + timedelta(days=100))
    assert decide(a, c).action == ResolutionAction.SHADOW


def test_latest_upload_is_only_fallback_for_equal_authority_without_effective_date():
    a = active(uploaded=NOW)
    c = candidate(uploaded=NOW + timedelta(minutes=1))
    assert decide(a, c).action == ResolutionAction.SUPERSEDE


def test_low_identity_confidence_fails_closed():
    assert decide(active(), candidate(confidence=0.5)).action == ResolutionAction.CONFLICT


def test_same_time_different_content_is_conflict():
    assert decide(active(uploaded=NOW), candidate(uploaded=NOW)).action == ResolutionAction.CONFLICT

from interlink_support.config import Settings


def test_ragflow_keyword_is_opt_in() -> None:
    assert Settings.model_fields["RAGFLOW_KEYWORD"].default is False

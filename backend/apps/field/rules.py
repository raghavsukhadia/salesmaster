class FieldRuleError(Exception):
    """A business rule refused the request. Views turn it into ``{"code", "detail", ...extra}`` + ``status``.

    A plain exception (not an APIException) so numeric details such as distances stay numbers in the JSON.
    """

    def __init__(self, code: str, detail: str, status: int = 422, **extra):
        super().__init__(detail)
        self.code, self.detail, self.status, self.extra = code, detail, status, extra

    def payload(self) -> dict:
        return {"code": self.code, "detail": self.detail, **self.extra}


class RuleErrorMixin:
    """For APIViews: render a FieldRuleError as its JSON payload with the rule's HTTP status."""

    def handle_exception(self, exc):
        if isinstance(exc, FieldRuleError):
            from rest_framework.response import Response

            return Response(exc.payload(), status=exc.status)
        return super().handle_exception(exc)

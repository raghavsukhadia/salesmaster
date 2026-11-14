from django.contrib.auth.models import AbstractUser
from django.db import models


class Role(models.TextChoices):
    SALESMAN = "salesman", "Salesman"
    MANAGER = "manager", "Manager"
    ADMIN = "admin", "Admin"


class User(AbstractUser):
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.SALESMAN)

    @property
    def is_management(self) -> bool:
        return self.role in (Role.ADMIN, Role.MANAGER)


class Salesman(models.Model):
    user = models.OneToOneField(User, on_delete=models.PROTECT, related_name="salesman")
    phone_number = models.CharField(max_length=20, unique=True)
    is_active = models.BooleanField(default=True)
    # 0 means "no target set". There is no money in the system yet, so targets are counts.
    daily_visit_target = models.PositiveIntegerField(default=0)
    monthly_visit_target = models.PositiveIntegerField(default=0)
    monthly_order_target = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.user.get_full_name() or self.user.username

    def __str__(self):
        return self.user.get_full_name() or self.user.username


class SalesmanTerritory(models.Model):
    """Planning only. Never grants dealer visibility."""

    salesman = models.ForeignKey(Salesman, on_delete=models.CASCADE, related_name="territories")
    state = models.CharField(max_length=80)
    city = models.CharField(max_length=80, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["salesman", "state", "city"], name="uniq_salesman_territory")
        ]

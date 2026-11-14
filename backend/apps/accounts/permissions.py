from rest_framework.permissions import BasePermission

from .models import Role


class HasRole(BasePermission):
    allowed_roles: tuple = ()

    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and u.role in self.allowed_roles)


class IsAdmin(HasRole):
    allowed_roles = (Role.ADMIN,)


class IsManagement(HasRole):
    allowed_roles = (Role.ADMIN, Role.MANAGER)


class IsSalesman(HasRole):
    allowed_roles = (Role.SALESMAN,)

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone


@pytest.mark.django_db(transaction=True)
def test_existing_orders_get_original_creator_name_without_changing_their_records():
    executor = MigrationExecutor(connection)
    latest = executor.loader.graph.leaf_nodes()
    before = [node for node in latest if node[0] != "visits"] + [("visits", "0006_visitphoto")]
    try:
        # Other migration tests may have rolled dependent apps back. Restore those first, so the next plan
        # only rolls back our new field; Django rejects a mixed forwards/backwards migration plan.
        executor.migrate(latest)
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        apps = executor.loader.project_state(before).apps
        User = apps.get_model("accounts", "User")
        Salesman = apps.get_model("accounts", "Salesman")
        Dealer = apps.get_model("dealers", "Dealer")
        Visit = apps.get_model("visits", "Visit")
        Item = apps.get_model("visits", "VisitOrderItem")
        user = User.objects.create(username="rakesh", first_name="Rakesh", last_name="Patil")
        salesman = Salesman.objects.create(user=user, phone_number="9000000001")
        dealer = Dealer.objects.create(name="Sharma Auto")
        visit = Visit.objects.create(salesman=salesman, dealer=dealer, visited_at=timezone.now(), notes="Original notes")
        Item.objects.create(visit=visit, product_name="HD 70", quantity=3)
        original_visit = Visit.objects.filter(pk=visit.pk).values().get()
        original_items = list(Item.objects.filter(visit=visit).values())
        fallback_user = User.objects.create(username="amit")
        fallback_salesman = Salesman.objects.create(user=fallback_user, phone_number="9000000002")
        fallback_visit = Visit.objects.create(salesman=fallback_salesman, dealer=dealer, visited_at=timezone.now())

        executor = MigrationExecutor(connection)
        executor.migrate(latest)
        apps = executor.loader.project_state(latest).apps
        Visit, Item = apps.get_model("visits", "Visit"), apps.get_model("visits", "VisitOrderItem")
        migrated = Visit.objects.filter(pk=visit.pk).values().get()
        assert migrated.pop("salesman_name") == "Rakesh Patil"
        assert migrated == original_visit
        assert list(Item.objects.filter(visit_id=visit.pk).values()) == original_items
        assert Visit.objects.get(pk=fallback_visit.pk).salesman_name == "amit"
    finally:
        MigrationExecutor(connection).migrate(latest)

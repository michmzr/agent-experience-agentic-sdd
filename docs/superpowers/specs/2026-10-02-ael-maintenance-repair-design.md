# Projekt uzupełnienia kontraktu naprawy AEL

Status: draft, 2026-10-02. Brak zatwierdzenia implementacji nowych kontraktów. Dokument towarzyszy planowi operacyjnej naprawy lokalnego AEL; istniejące zaakceptowane ABI/ARC/AEC pozostają obowiązujące.

## Problem i dowody

`hooks verify --worktree` zwraca `BUILD_MISSING` dla trzech poprawnych managed wrapperów kierujących do wspólnego lokalnego buildu i `WORKTREE_INVALID` dla zarejestrowanego workspace SecondBrain bez Git. Odrębny test bezpośrednich wrapperów dostarczył zdarzenia przez 10/10 źródeł. Wynik nie stanowi dowodu automatycznej dostawy z hosta.[^evidence]

Analiza ma cztery zadania `quarantined-input`: dwa execution-failure, jedno invalid-input, jedno historyczne bez reason. Istniejący reconcile przyjmuje brakującą pracę, lecz nie jest publicznym mechanizmem bezpiecznego wznowienia niezmienionego zakresu z kwarantanny. Przyczyny błędów wykonania nie zostały jeszcze odtworzone.

## Zakres

Rozszerzyć weryfikację o zarejestrowany Git root i jawny workspace bez Git, odczytując faktyczny managed target. Dodać bounded, jawny mechanizm wznowienia wskazanych zadań analizy po potwierdzonej naprawie ich przyczyny. Nie zmieniać domyślnych ustawień advice ani polityki runtime.

## Proponowane zachowanie

Weryfikacja przyjmuje istniejące `--worktree` oraz nową selekcję `--repository-id`, wzajemnie wykluczające się. Target pochodzi z rozpoznanego wrappera; build przechodzi sprawdzenie manifestu i capabilities. Synthetic wrapper verification oraz real-host qualification są osobnymi faktami. Sukces testu synthetic nie nadaje statusu qualified hosta.

Naprawa analizy ma podgląd i apply analogiczne do ARC: selekcja zawiera opaque job IDs, repository scope, detector version, input range, stan, build identity i hash. Limit partii to 100. Apply odrzuca zmienione wejście, scope, capabilities i plan. Awaria nie rozszerza selekcji. Powtórzenie i restart są idempotentne. Oryginalna kwarantanna i historia prób pozostają audytowalne, a nowa generacja ma ograniczony budżet wykonania.

Szczegółowy schemat generacji, nazwy nowych komend i migracja zostaną ustalone w implementacyjnym planie po zatwierdzeniu specyfikacji oraz reprodukcji awarii. Nie udostępniać ogólnego resetu zadań ani bezpośredniego SQL jako publicznej ścieżki naprawczej.

## Ograniczenia

Nie fabrykować brakującej sesji ani scope na podstawie cwd. Nie usuwać starych `CORRUPT`, nie uznawać nieznanego wyniku za poprawny i nie tworzyć pustej wiedzy w celu uzyskania `healthy`. Naprawa błędnego wejścia wymaga kwalifikowanego wejścia; naprawa wykonania wymaga reprodukcji przyczyny. Passive capture pozostaje fail-open.

## Kryteria akceptacji

| ID | Sprawdzenie |
|---|---|
| LMR-A1 | Registered Git repo bez własnego dist, z poprawnym shared target: test wrappera przechodzi; brak/modyfikacja targetu są odrzucane |
| LMR-A2 | Registered workspace bez Git jest weryfikowany przez jego ID, a inny lub nieznany scope zostaje odrzucony |
| LMR-A3 | Wynik synthetic nie może sam ustanowić qualified real host; startup i resume mają odrębny dowód |
| LMR-A4 | Plan wznowienia odrzuca stale hash, zmieniony zakres, cross-scope i niezgodny writer przed mutacją |
| LMR-A5 | Wybrane poprawne zadanie po naprawie przyczyny wykonuje się w nowej generacji, powtórzenie apply nie duplikuje efektów; oryginalna kwarantanna pozostaje |
| LMR-A6 | Przerwanie w połowie partii, restart i niesprawna baza nie powodują utraty capture, nieograniczonych prób ani zmiany authority wiedzy |

## Wdrożenie

Najpierw isolated fixtures i kopia danych z kontrolą integrity oraz foreign keys. Następnie jeden canary i stopniowe partie na produkcji. Rollback respektuje writer floor i zachowuje późniejsze zapisy; backup nie jest bezwarunkowym narzędziem nadpisania działającej bazy.

## Ryzyko i zakres regresji

Główne ryzyka to błędna korelacja scope, powtórne przetworzenie tego samego zakresu oraz ukrycie pierwotnej awarii. Wymagane kontrole to negative scope, stale plans, interruption/restart, privacy, bounded attempts i istniejące golden v1/v2. Nowe fields/komendy nie mogą zmieniać istniejących serializacji. Wymagane są `rtk pnpm check`, testy worker/recovery/hook-readiness oraz dowód real-host oddzielony od fixtures.

[^evidence]: Lokalny audyt 2026-10-02, `src/cli/hook-readiness.ts`, `src/installation/inspection.ts`, `src/learning/reconciliation.ts`, `src/learning/repository.ts`; wartości historyczne i plany operacyjne w `docs/superpowers/plans/2026-10-02-ael-local-repair.md`.

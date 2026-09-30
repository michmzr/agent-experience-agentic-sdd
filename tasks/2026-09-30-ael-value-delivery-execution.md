# Plan wykonania specyfikacji AEL

Status: w trakcie. Użytkownik zlecił 2026-09-30 wykonanie wszystkich ośmiu specyfikacji z indeksu AEL z podziałem na subagentów. Ten plan koordynuje istniejące plany kryteriów, nie zastępuje ich.

## Stan końcowy i weryfikacja

Każde kryterium ABI, AEC, ARC, ASC, ATI, ACL, AAP i AVB ma wykonany test wymagany w swoim planie, wynik publicznej ścieżki lub jawny status `unsupported` tam, gdzie kontrakt dopuszcza brak danych źródłowych. Po ostatniej zmianie kodu przechodzi `rtk pnpm check`; sprawdzone są migracja, restart, granice prywatności i rollback adekwatne do zmiany. Indeks dostaw wskazuje tylko fakty potwierdzone raportami. Kwalifikacja rzeczywistych hostów i rollout są osobnymi obserwowalnymi operacjami.

## Grupy i własność plików

| Grupa | Zależność | Worktree i właściciel | Wyłączna własność podczas pracy | Punkt kontrolny |
|---|---|---|---|---|
| AVB-B0 | stan `main` przed integracją ABI | `avb-baseline`, agent AVB | `src/benchmark/**`, testy i fixture AVB, `src/cli.ts` w tej gałęzi | Niezmienny baseline opisany jako stan `main` przed integracją, bez twierdzenia o historycznym pomiarze sprzed ABI |
| ABI-A5 / ARC-4 magazyn paragonów | rdzeń ABI | `arc-receipt-integration`, agent paragonów | `src/capture/spool.ts`, `src/capture/hook-ingress.ts`, `src/capture/receipts.ts`, testy ABI-A5 i paragonów | Atrybucja buildu przechwycenia i writera retry w osobnych rolach; stare paragony `unknown`; retencja i migracja |
| AEC | rdzeń ABI | `aec-continuity`, agent AEC | adapter Codex, `src/evidence/**`, `src/storage/experience-store.ts`, `src/learning/service.ts`, `src/learning/repository.ts`, `src/application/experience-service.ts`, testy AEC | AEC-A1–A6; źródłowe koperty tylko po kwalifikacji, bez wymyślania danych hosta |
| ARC pozostałe | AEC i magazyn paragonów | nowy worktree po integracji | `src/cli.ts`, `src/application/experience-service.ts`, odzyskiwanie, rekoncyliacja i health v3 | ARC-A1–A6 oraz pełne ABI-A5 |
| ASC | AEC | osobny worktree po AEC | zakresy i konwencje; współdzielone pliki learning tylko po zwolnieniu ich przez ARC | ASC-A1–A5 |
| ATI | AEC i ARC | osobny worktree po ARC | producent typowanych danych; `src/cli.ts` tylko po ARC | ATI-A1–A6 |
| ACL | ASC i ATI | osobny worktree po ATI | kandydaci, przegląd, retrieval; `src/cli.ts` tylko po ATI | ACL-A1–A7 |
| AVB-B1 | ABI, AEC, ARC, ASC, ATI i ACL | gałąź benchmarku po integracji | `src/benchmark/**` i fixture AVB | Publiczny pipeline i bramki bezpieczeństwa AVB-A2–A3 |
| AAP i AVB-B2 | AVB-B1; decyzja ADR 002 przed AAP | kolejne osobne worktrees | doradztwo, następnie benchmark porównawczy | AAP-A1–A5 i AVB-A4–A6 |

Główny checkout zawiera niezatwierdzone pliki dokumentacji użytkownika. Nikt nie edytuje ich w miejscu. Specyfikacje i plany są przenoszone selektywnie do właściwych worktrees; nowszych dokumentów ABI nie wolno nadpisać wersją z `main`.

## Kolejność integracji

1. Zweryfikować i przejrzeć trzy równoległe grupy AVB-B0, ABI-A5/ARC-4 i AEC. Każda pracuje w osobnym worktree bez wspólnych edycji.
2. Scalić AEC z rdzeniem ABI, następnie magazyn paragonów. W razie konfliktu zachować jednego właściciela pliku i ponowić pełną ścieżkę akceptacji.
3. Dokończyć ARC i ASC w osobnych worktrees. Zmiany `src/learning/**` i `src/cli.ts` integrować kolejno.
4. Po zamknięciu ARC i ASC wykonać ATI, ACL, AVB-B1, AAP i AVB-B2 zgodnie z zależnościami. Nie ogłaszać korzyści netto bez porównania i telemetrii przewidzianych w AVB.

Wynik AVB-B0 z obecnego `main` nie będzie nazywany historycznym pomiarem sprzed implementacji ABI. Zachowany syntetyczny baseline ABI jest odrębnym artefaktem.

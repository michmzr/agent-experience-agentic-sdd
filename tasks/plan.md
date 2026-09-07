# Plan prac nad specyfikacjami AEL

Status: Draft, zaktualizowany 2026-09-06. Roboczy podział P0–P5 został zastąpiony kamieniami milowymi M4–M9. Ten plik jest nawigacją po specyfikacjach, nie planem implementacyjnym.

## Dokumenty nadrzędne

- [Indeks kamieni milowych](../docs/product/operational-memory-milestones.md): zakres, zależności, mapowanie P0–P5 i bramki odbioru.
- [Roadmapa produktu](../docs/product/roadmap.md): historia dostaw i nowa kolejność M4–M9.
- [ADR 001](../docs/decisions/001-asynchronous-passive-observation.md): propozycja trwałej kolejki i asynchronicznego przetwarzania.
- [Lista prac](todo.md): stan dokumentacji oraz następne kroki SDD.

## Kolejność

| Milestone | Efekt | Specyfikacja |
|---|---|---|
| M4 | Trwałe asynchroniczne zbieranie bez czekania na główną bazę i analizę | [Capture](../docs/superpowers/specs/2026-09-06-m4-asynchronous-passive-capture-design.md) |
| M5 | Wiarygodny przebieg sesji, wyniki, luki i metryki | [Dowody sesji](../docs/superpowers/specs/2026-09-06-m5-session-evidence-design.md) |
| M6 | Pasywne odtwarzanie problemów, skutecznych korekt i lokalnych lekcji | [Uczenie operacyjne](../docs/superpowers/specs/2026-09-06-m6-operational-learning-design.md) |
| M7 | Wiedza o zasobach, połączeniach i interwencji przy SSO | [Zasoby](../docs/superpowers/specs/2026-09-06-m7-resource-discovery-design.md), [SSO](../docs/superpowers/specs/2026-09-06-m7-sso-observation-design.md) |
| M8 | Osobno włączane podpowiedzi przed akcją | [Wykorzystanie wiedzy](../docs/superpowers/specs/2026-09-06-m8-advisory-reuse-design.md) |
| M9 | Ponowne użycie między agentami i pomiar efektów netto | [Benchmark](../docs/superpowers/specs/2026-09-06-m9-effectiveness-benchmark-design.md) |

M4–M7 muszą działać bez ingerowania w agenta. Pomiar kosztu i narzutu zaczyna się w M4/M5. M8 jest osobno włączany i nie jest warunkiem użyteczności trybu pasywnego.

## Następny etap SDD

Rozstrzygnąć otwarte decyzje M4 i zatwierdzić jego kontrakt. Następnie przygotować wykonawczy plan implementacji w projektowym katalogu `docs/superpowers/plans/`. Zatwierdzenie jednego milestone'u nie zatwierdza automatycznie pozostałych specyfikacji.

Obecna praca obejmuje wyłącznie organizację dokumentacji. Nie zmieniono kodu, konfiguracji hooków ani danych AEL. Nie poświadczono jeszcze realizacji kryteriów M4–M9.

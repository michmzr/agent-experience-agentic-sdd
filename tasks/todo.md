# Lista prac SDD nad pivotem AEL

Status: przygotowano specyfikacje Draft. Żaden nowy milestone nie jest oznaczony jako wdrożony.

## Wykonana organizacja

- [x] Porównać wymagania z dokumentacją i ścieżkami kodu.
- [x] Uwzględnić pasywną obserwację bez blokad, pytań i podpowiedzi.
- [x] Uwzględnić trwałą kolejkę, asynchroniczne przetwarzanie i odzyskiwanie.
- [x] Zastąpić roboczy podział P0–P5 kamieniami milowymi M4–M9.
- [x] Utworzyć siedem specyfikacji według szablonu projektu.
- [x] Zapisać proponowaną granicę architektoniczną w ADR 001.
- [x] Powiązać indeks, roadmapę, mapę dokumentacji i instrukcję SDD.
- [x] Sprawdzić strukturę siedmiu specyfikacji, unikalność 51 kryteriów i 70 lokalnych linków w 14 plikach; brak błędów. `git diff --check` zakończone poprawnie 2026-09-06. Testy aplikacji nie były uruchamiane dla zmian wyłącznie dokumentacyjnych.

## Kolejne dostawy

- [ ] M4: rozstrzygnąć format kolejki, trwałość, budżety i mechanizm odzyskiwania; zatwierdzić spec.
- [ ] M4: przygotować plan implementacji i wykazać odzyskanie zdarzeń oraz ograniczony narzut.
- [ ] M5: zatwierdzić spec rekonstrukcji i pomiarów; przygotować plan i dowody realizacji.
- [ ] M6: zatwierdzić spec lokalnych epizodów i lekcji; zweryfikować scenariusze doboru narzędzia oraz naprawionej komendy.
- [ ] M7: zatwierdzić obie specyfikacje; zweryfikować obserwację zasobów i SSO bez interwencji.
- [ ] M8: zatwierdzić kontrakt opt-in i delivery; zweryfikować sesję A→B z podpowiedzią.
- [ ] M9: ustalić progi na podstawie baseline; wykazać skuteczność między agentami i koszt netto.
- [ ] Każda dostawa: wykonać wymagane testy, zachować traceability i review przed merge.

Zakres oraz kryteria odbioru: [indeks M4–M9](../docs/product/operational-memory-milestones.md).

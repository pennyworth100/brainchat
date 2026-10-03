# Dimle — kierunek wizualny i przekazanie

> Dokument i zrzuty poniżej opisują historyczny wariant UI BRA-2, nie testy zintegrowanego kandydata BRA-4. Stan integracji security, obsługa identyfikatorów i aktualna weryfikacja: [BRA-4](../integration/BRA-4.md).

Wariant: `design/bra-2-editorial-ui`, baza `main` / `50c248b`.

## Kierunek

Redakcyjny charakter America.gov: duży szeryf, mocna hierarchia, białe tło, granatowe akcenty, cienkie linie i spokojne odstępy. Dimle zachowuje nazwę, dotychczasowy opis i funkcje. Nowe krótkie nagłówki: „Just a room. Just us.” oraz „Make room.”. Bez fotografii, pieczęci i oznaczeń rządowych.

Inspekcja: istniejący kod oraz strona Dimle potwierdzają dotychczasowy mały formularz i ciepłą paletę. America.gov zwraca Cloudflare „Just a moment…” w curl i Chromium; web również nie odczytał strony. Informacje o Rhymes Text/Display, Helvetica Now i kolorach pochodzą z inspekcji live podanej w zadaniu z 2026-10-02. Nie potwierdzono niezależnie aktualnych odstępów ani zachowania mobilnego referencji. Własne proporcje dostosowano do funkcji Dimle.

## Fonty i licencje

W repozytorium nie znaleziono licencji Rhymes ani Helvetica Now. Nie pobierano tych fontów ani plików z America.gov.

- Rhymes: komercyjny krój Maxitype, warianty Text i Display; wymaga właściwej licencji. Źródło: https://maxitype.com/typeface/rhymes/.
- Helvetica Now: komercyjny krój Monotype; użycie web wymaga odpowiedniego uprawnienia. Źródła: https://www.monotype.com/fonts/helvetica-now i https://www.myfonts.com/collections/helvetica-now-font-monotype-imaging.
- Zastosowano **Newsreader** (nagłówki) i **Inter** (interfejs), oba SIL Open Font License 1.1. OFL pozwala na użycie komercyjne i osadzanie z zachowaniem licencji. Nie wolno sprzedawać samego fontu.
- Źródła plików: https://github.com/google/fonts/tree/main/ofl/newsreader oraz https://github.com/google/fonts/tree/main/ofl/inter. Licencje: https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/OFL.txt oraz https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt.
- Niezmienione fonty TTF i pełne licencje są w `public/fonts`. Lokalny hosting, `font-display: swap`; bez żądań do Google Fonts. Newsreader zastępuje charakter szeryfu, nie stanowi kopii Rhymes. Inter zachowuje czytelność i ciągłość z dotychczasowym UI.

## Specyfikacja i źródła edytowalne

- Tekst `#000C1F`, akcent `#002664`, tło białe / `#F8F9FB`, tekst pomocniczy `#536177`.
- Hero: Newsreader 60–120 px; nagłówek formularza 44–56 px; pokój 34–44 px. UI: Inter, zwykle 14–16 px.
- Desktop: dwie kolumny, margines 5vw, odstępy 88/104 px. Do 700 px: jedna kolumna, margines 24 px, odstępy 44/48 px.
- Przyciski startowe min. 56 px; promień 3–4 px; fokus 3 px z odstępem. Formularz kodu ma etykietę, komunikat alert i `aria-invalid`.
- Pokój: wspólna paleta, nagłówek szeryfowy, ograniczona szerokość treści do około 1040 px, pole wiadomości `min-width: 0`, wysokość `100dvh`, uwzględniony dolny safe area.
- Edytowalne źródła: `src/app/page.tsx`, `src/app/room/page.tsx`, `src/app/globals.css`, `tailwind.config.ts`. Brak zmian backendu, autoryzacji i konfiguracji infrastruktury.
- Ikona załącznika: wektor inline SVG w komponencie pokoju, 20×20 px, bez dodatkowej biblioteki.

## Weryfikacja

- `npm ci --no-audit --no-fund`: OK.
- `npm run build`: OK, także sprawdzenie typów i statyczne generowanie obu tras. Repo nie ma skryptu testów.
- `git diff --check`: OK.
- Chromium / Playwright: 1440×1000, 390×844 i 320×720. Walidacja błędnego kodu, wejście do pokoju przez Enter, losowy czterocyfrowy kod Create Room, formularz nazwy i obsługa pola wiadomości: OK. Brak poziomego przepełnienia pokoju.
- Oceniono zrzuty strony, formularza wejścia i pustego pokoju. Zrzuty pokazują lokalny build; pokój ma 0 online, ponieważ podgląd uruchomiono bez Socket.IO i bazy. Nie są dowodem dostarczenia lokalnej wiadomości.
- Staging: dwie niezależne sesje Chromium, Create Room → Join Chat → wysłanie i odczyt wiadomości u drugiego uczestnika: **OK**.
- Ograniczenie: staging tworzy długie identyfikatory, a repo bazowe czterocyfrowe. Staging nie jest dowodem E2E dla tej gałęzi. Lokalny pełny serwer wymaga `DATABASE_URL` / PostgreSQL, których środowisko nie udostępnia. Nie zmieniano backendu, aby obejść tę zależność.
- Kontrast: białe litery na granacie oraz tekst główny i pomocniczy na jasnych tłach przekraczają 4.5:1. Widoczny fokus i większy kontrast tekstów pomocniczych niż w bazie. Pełny audyt screen readera i test fizycznej klawiatury mobilnej pozostają poza wykonaną kontrolą.

## Eksporty i użycie

`home-*`, `join-*`, `room-*`: PNG. Desktop 1440×1000, mobile szerokość 390 px, small szerokość 320 px; zrzuty pełnej strony mogą być wyższe od viewportu. Używać do oceny projektu, nie jako materiały ogłoszenia wdrożenia. Brak produkcyjnego wdrożenia.

Do Alfreda i Elona: przed scaleniem sprawdzić ten commit w środowisku z bazą, zwłaszcza dostarczanie wiadomości, pliki, DM i klawiaturę mobilną; rozstrzygnąć rozbieżność wersji repo/staging. Oryginalne hasło „No history” zachowano zgodnie z zakresem, choć kod zawiera historię wiadomości — wymaga osobnej decyzji produktowej.

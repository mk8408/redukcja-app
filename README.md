# Redukcja Pro – Sobotnie Ważenia i Kamienie Milowe (PWA)

Aplikacja webowa typu **Progressive Web App (PWA)** stworzona z myślą o hostingu na **GitHub Pages** oraz instalacji jako natywna aplikacja na telefonie z systemem **Android**.

## Główne funkcje

1. **Kalkulator składu ciała i celu redukcji:**
   - Wprowadzasz: **wiek**, **aktualną wagę (kg)**, **aktualny poziom tkanki tłuszczowej (%)**, **docelowy poziom tkanki tłuszczowej (%)** oraz **czas na osiągnięcie celu (w tygodniach)**.
   - Aplikacja automatycznie oblicza **beztłuszczową masę ciała (LBM)**, docelową wagę końcową przy zachowaniu masy mięśniowej, wymagany tygodniowy spadek masy ciała oraz szacowany dzienny deficyt kaloryczny.
2. **Cotygodniowe kamienie milowe (Sobotnie ważenia):**
   - Harmonogram automatycznie wyznacza kolejne **soboty** od daty rozpoczęcia planu.
   - Każda sobota posiada przypisany cel wagowy i procentowy poziom tkanki tłuszczowej.
3. **Automatyczna korekcja celu przy obsunięciach:**
   - Jeśli podczas sobotniego ważenia wystąpi obsunięcie (waga jest wyższa niż zakładany kamień milowy), aplikacja koryguje plan w jednym z dwóch trybów:
     - **Korekcja tempa (stały termin):** przelicza ścieżkę na pozostałe tygodnie od ostatniego pomiaru, odpowiednio zwiększając tygodniowy cel redukcji, aby zdążyć na czas.
     - **Korekcja terminu (stałe tempo):** zachowuje pierwotne, bezpieczne tempo tygodniowe i automatycznie przesuwa cele oraz dopisuje dodatkowe sobotnie kamienie milowe.
4. **Trwałe przechowywanie pomiarów:**
   - Wszystkie pomiary i ustawienia zapisują się automatycznie w pamięci telefonu (`localStorage`).
   - Dostępny jest również eksport i import kopii zapasowej **JSON** oraz eksport tabeli do pliku **CSV (Excel)**.

## Jak opublikować za darmo na GitHub Pages?

1. Utwórz nowe repozytorium na GitHubie (np. `redukcja-pro`).
2. Wgraj wszystkie pliki z tego folderu (`index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, `icon.svg`, `icon-192.png`, `icon-512.png`).
3. W repozytorium przejdź do **Settings → Pages**.
4. W sekcji **Build and deployment → Source** wybierz **Deploy from a branch**, wskaż gałąź `main` oraz folder `/ (root)` i kliknij **Save**.
5. Po chwili aplikacja będzie działać pod adresem `https://twoj-login.github.io/redukcja-pro/`.

## Jak zainstalować na telefonie z Androidem?

1. Otwórz link z GitHub Pages w przeglądarce **Chrome** na telefonie z Androidem.
2. Kliknij przycisk **„📲 Zainstaluj (Android)”** w górnym pasku aplikacji (lub wybierz z menu przeglądarki **⋮ → Zainstaluj aplikację / Dodaj do ekranu głównego**).
3. Aplikacja pojawi się na ekranie głównym telefonu i będzie działać również w trybie **offline**.

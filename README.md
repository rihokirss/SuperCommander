# SuperCommander

Kahe paneeliga Windowsi failihaldur: Rusti tuum, Tauri 2 ja React/TypeScript. Tasapinnaline tume kujundus, õrn jäätunud klaasi efekt ning eesti ja inglise kasutajaliides.

Seadetes saab valida tumeda või heleda teema, järgida Windowsi teemavalikut ning muuta klaasiefekti ja reavahet. Failiridade vaikekõrgus on 32 px. Failitoimingute loend kasutab samuti kompaktseid ridu; konflikti- ja veadetailid avanevad nende alla.

## Käivitamine

Vaja on Node.js 24 LTS-i ja Rusti stable-tööriistu. Windowsis on lisaks vaja Visual Studio C++ Build Toolsi koos Windows SDK-ga ning WebView2 käituskeskkonda.

```sh
npm ci
npm run tauri dev
```

Brauseris saab kujundust ja navigeerimist vaadata käsuga `npm run dev` aadressil `http://127.0.0.1:1420`. Brauserirežiim kuvab selgelt märgistatud näidisfaile; päris failitoimingud, SFTP ja terminal töötavad töölauarakenduses.

## Windowsi ehitamine

Windowsis:

```sh
npm run tauri build
```

NSIS-paigaldaja tekib kausta `target/release/bundle/nsis/`. Paigaldus on kasutajapõhine ning WebView2 puudumisel laadib paigaldaja selle alla. Paigaldaja ei ole digitaalselt allkirjastatud. Automaatuuendusi ei ole.

WSL-is saab ehitada MSVC sihtplatvormile ilma Windowsi Rusti paigalduseta:

```sh
sudo apt-get install clang lld llvm nsis
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
npm run build:windows
```

`cargo-xwin` laadib alla Windows SDK ja CRT. Väljund: `target/x86_64-pc-windows-msvc/release/supercommander.exe` ning sama kausta `bundle/nsis/` paigaldaja. Ristkompileerimise õnnestumine ei asenda Windowsis käivitamise kontrolli.

WSL-is/Linuxis töölauarakenduse arendamiseks on vaja ka `build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev` pakette.

## Kasutamine

- Kummalgi paneelil on oma vahelehed, ajalugu, sortimine ja filter. Asukoharibale klõpsates saab sisestada ketta-, kausta- või UNC-tee. Ctrl+T avab vahelehe, Ctrl+W sulgeb selle.
- Klõps valib faili; Ctrl-klõps muudab mitmikvalikut, Shift valib vahemiku. Insert märgib praeguse faili või eemaldab märgistuse ning viib kursori järgmisele reale, nagu Midnight Commanderis. Viimasel real jääb kursor paigale. Nooleklahvid säilitavad märgistused. Faililoendis vahetab Tab paneeli; Enter avab kursori all oleva faili või kausta.
- F2 nimetab ümber, F3 avab eelvaate, F4 välise redaktori, F5 kopeerib teise paneeli, F6 teisaldab ja F7 loob kausta. F8 ja Delete kasutavad prügikasti; Shift+F8 ja Shift+Delete küsivad jäädava kustutamise kinnitust. Kaugserveris tähendab kustutamine jäädavat kustutamist ja küsib kinnitust.
- Faili saab lohistada teise paneeli. Shift-lohistamine teisaldab. Explorerist rakendusse lohistamine kopeerib.
- Ctrl+F avab rekursiivse nimeotsingu koos suuruse ja kuupäeva filtritega. Ctrl+P või Ctrl+K avab käsupaleti.
- ZIP-i loomine ja lahtipakkimine asuvad lisatoimingute menüüs. ZIP-i topeltklõps avab kirjutuskaitstud sisu; ülemise kausta nupp väljub arhiivi juurkaustast.
- SFTP profiil luuakse külgribalt või sisestatakse paneeli asukoharibale `sftp://kasutaja@server:2222/tee`, `ssh://kasutaja@server/tee` või `kasutaja@server:/tee`. SSH-teed avanevad SFTP kaudu samas paneelis. Avatud ühendust saab kasutada mõlemas paneelis; teise serveri või kasutaja jaoks avaneb eraldi autentimine. Esimesel ühendamisel tuleb serverivõtme SHA-256 sõrmejälg üle kontrollida. Salvestatud parool või võtme parool läheb Windows Credential Managerisse, mitte seadete faili.
- Tab vahetab tavavaates paneeli ka tööriistaribalt. Dialoogides liigub Tab väljade vahel ja terminalis täiendab käsurida.
- Ctrl+` näitab või peidab kohalikku interaktiivset terminali. Ctrl+O vahetab failipaneelid täissuuruses terminali vastu ja tagasi, säilitades sama shelliseansi. X sulgeb terminaliseansi. Kasutatakse PowerShell 7-t või selle puudumisel Windows PowerShelli. Terminal säilitab oma töökataloogi; paneelis navigeerimine sinna automaatselt käske ei saada.

## Andmed ja tööde käitumine

Seaded, vahelehed, ühenduste profiilid ja järjehoidjad salvestatakse kasutaja seadete kausta `SuperCommander/settings.json`. Windowsis on see `%APPDATA%/SuperCommander/`. Eelmine seadistus säilib varukoopiana. Saladusi seadete faili ei kirjutata.

Failitoimingud käivad ühes järjekorras. Koopia kirjutatakse kõigepealt ajutisse `.part` faili. Asendamisel säilib vana fail kuni uue koopia valmimiseni. Teisaldamisel eemaldatakse lähtefail pärast edukat kopeerimist. Vahele jäetud või ebaõnnestunud kataloogikoopia korral jääb lähtekataloog alles. Katkestamine eemaldab pooleli oleva ajutise koopia, kuid juba lõpetatud faile tagasi ei võta. Ühe kustutatava kataloogi eemaldamine ei ole poole pealt katkestatav.

Sümboolseid linke ja Windowsi junction'eid ei kopeerita ega järgita rekursiivses otsingus. ZIP-i lahtipakkimine kontrollib teid ja tõkestab sümboolsete linkide kaudu sihtkaustast väljumise. ZIP-vaatest üle 128 MiB üksikfaili kopeerimise asemel kasuta arhiivi lahtipakkimist.

Esimese versiooni arhiivitoimingud töötavad kohalike ZIP-failidega. SFTP-failid liiguvad kliendi kaudu; serveritevaheline otseülekanne, serveripoolne prügikast, 7z/RAR, kataloogide sünkroonimine ja sisseehitatud tekstiredaktor ei kuulu sellesse versiooni. Kaugfaili saab eelvaadata või kopeerida kohalikule kettale välise rakendusega avamiseks.

## Kontrollid

```sh
npm test
npm run test:ui
npm run build
cargo test -p commander-core
cargo test -p commander-core streams_one_hundred -- --ignored
```

Liidesetestid kasutavad Playwrighti Chromiumit: `npx playwright install chromium`. Testitakse sõltumatuid paneele, ajalugu, filtreid, otseteid, dialooge, keelevahetust ja paigutust 960–1920 px laiustel. Rusti testid kontrollivad päris ajutiste failidega kopeerimist, teisaldamist, katkestamist, konflikte, ZIP-i, eelvaateid ja ümbernimetamist.

Päris OpenSSH integratsioonitest WSL-is (vaja `openssh-server` ja `ssh-keygen`):

```sh
cargo test -p commander-core --test sftp -- --ignored --nocapture
```

Test käivitab ajutiste võtmetega serveri ainult aadressil `127.0.0.1` juhuslikul pordil. Kontrollitakse tundmatut ja muutunud serverivõtit, võtmega autentimist, valet parooli, failiedastust ja suletud ühenduse veakäsitlust.

Windowsi tegeliku rakenduse suitsutest: käivita rakendus protsessipõhise keskkonnamuutujaga `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`, seejärel käivita **Windowsi Node'iga** `node scripts/windows-smoke.mjs`. Ära määra silumismuutujat süsteemiüleselt. Test loob oma ajutise kataloogi, teeb liidese kaudu failitoimingud ning kontrollib PDF-i, pildieelvaadet, prügikasti ja PowerShelli/ConPTY-t. Testkataloog eemaldatakse lõpus. Vali püsiv kuvatõmmise asukoht muutujaga `SC_SCREENSHOT`.

SSH-paneeli liidesetesti kaasamiseks käivita WSL-is enne suitsutesti `node scripts/sftp-fixture.mjs`. See loob ajutise OpenSSH-serveri, võtmed ja testfaili. Windowsi suitsutest kontrollib serveri sõrmejälge ning kopeerib faile kohalikust paneelist SSH-paneeli ja tagasi. Testserver peatatakse Ctrl+C-ga; selle võtmed ja testandmed eemaldatakse. Windowsi suitsutest taastab algsed seaded.

CI-töövoog `.github/workflows/windows.yml` kontrollib ja ehitab Windows x64 paigaldaja. Avaldamine või koodiallkirjastamine pole automaatne.

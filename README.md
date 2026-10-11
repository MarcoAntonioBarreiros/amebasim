# Ameba Sol-Gel

Simulação do movimento ameboide pelo modelo sol-gel, para celular (Android) e navegador.

A ameba se move por contração posterior (miosina II), gelificação da rede de actina junto à
membrana e adesão ao substrato. Os pseudópodes crescem, ramificam, tateiam o ambiente e competem
entre si. A célula fagocita bactérias, que liberam um atraente detectado pela ponta de cada
pseudópode (resposta relativa ao gradiente, lei de Weber).

## Usar

- **Android:** baixe `ameba-sol-gel.apk` na página [Releases](../../releases/latest) e abra o
  arquivo no celular. O Android pede para permitir a instalação de apps desta fonte.
  Versões novas instalam por cima da anterior.
- **Proteção de tela (Android):** depois de instalar o APK, vá em *Configurações → Tela →
  Proteção de tela* e escolha **Ameba Sol-Gel**. Ela liga enquanto o celular carrega (ou na base,
  conforme o ajuste do aparelho) e usa a iluminação e os parâmetros escolhidos no menu do app.
  O botão de configurações da proteção de tela abre o app.
- **Navegador (qualquer celular, inclusive iPhone):** abra
  `https://marcoantoniobarreiros.github.io/amebasim/` e use "Adicionar à tela inicial".
  Depois da primeira visita funciona sem internet.

## Controles

- **Toque no campo:** coloca uma micropipeta com atraente. O sinal se esgota sozinho.
- **Pinça com dois dedos:** zoom. A câmera acompanha a ameba.
- **Botão no canto ou botão voltar:** pausa e abre o menu com todos os controles
  (velocidade, campo claro/escuro, motor celular, polaridade, inibidores, ambiente, camadas).

## Estrutura

| Pasta / arquivo | Conteúdo |
|---|---|
| `src/amoeba-core.js` | Núcleo da simulação, sem dependência de página (Verlet, mesma convenção da DarwinRizo) |
| `src/page.html` | Bancada de ajuste (versão de computador) — fonte da renderização e dos controles |
| `src/mobile-shell.html` | Casca do app: tela cheia e menu de pausa |
| `src/mobile-build.py` | Junta núcleo + página + casca em `www/index.html` |
| `src/make-icons.py` | Gera ícones e telas de abertura |
| `www/` | App web (o que vai para o GitHub Pages e para dentro do APK) |
| `android/` | Projeto Android (Capacitor 7) |
| `.github/workflows/build.yml` | A cada envio: compila o APK, publica em Releases e atualiza o Pages |

Para alterar o app: edite os arquivos em `src/`, rode `python3 src/mobile-build.py` e envie.
O GitHub compila o resto.

O APK é assinado com uma chave fixa de depuração (`android/app/ameba-debug.keystore`, senha
padrão `android`). Ela não é secreta; serve só para manter a mesma assinatura entre versões.
Para publicar na Play Store seria preciso uma chave de lançamento própria.

## Licença

CC BY-NC 4.0 — Marco Antonio Bacellar Barreiros, FIXTEC / UFPR Palotina.

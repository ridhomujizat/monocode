{
  description = "MonoCode — Tauri desktop app (React + Rust)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs:
        let
          # On darwin the shell sets DEVELOPER_DIR/SDKROOT to nixpkgs' Apple
          # SDK, so even /usr/bin/cc resolves to nix's clang, which honours
          # NIX_LDFLAGS and resolves libc's `-liconv` to a /nix/store dylib.
          # That path gets baked into the binary as its install_name, and the
          # bundled .app aborts at launch outside the shell:
          #   Library not loaded: /nix/store/...-libiconv/lib/libiconv.2.dylib
          #   ... mapping process and mapped file have different Team IDs
          # Link with the system toolchain instead, resolved at runtime so
          # this works with either Command Line Tools or a full Xcode.
          appleLinker = pkgs.writeShellScript "apple-clang-linker" ''
            dev=$(env -u DEVELOPER_DIR /usr/bin/xcode-select -p)
            sdk=$(env -u DEVELOPER_DIR -u SDKROOT /usr/bin/xcrun --show-sdk-path)
            exec env -u NIX_LDFLAGS DEVELOPER_DIR="$dev" SDKROOT="$sdk" \
              "$dev/usr/bin/clang" "$@"
          '';
          cargoLinkerVar = "CARGO_TARGET_" + builtins.replaceStrings [ "-" ] [ "_" ]
            (pkgs.lib.toUpper pkgs.stdenv.hostPlatform.rust.rustcTarget) + "_LINKER";
        in
        {

        default = pkgs.mkShell {
          # CI pins Node 20, which nixpkgs has dropped (EOL 2026-04-30);
          # 22 is the nearest supported line. Staying off Node >= 26 is the
          # point: it exposes a built-in `localStorage` global that shadows
          # happy-dom's and breaks every `@vitest-environment happy-dom` suite.
          packages = with pkgs; [
            nodejs_22
            rustc
            cargo
            rustfmt
            clippy
            pkg-config
            # No libiconv here on purpose: macOS ships its own in /usr/lib,
            # and linking nixpkgs' copy bakes a /nix/store install_name into
            # the binary. The bundled .app then aborts at launch with
            # "Library not loaded ... different Team IDs".
          ] ++ lib.optionals stdenv.hostPlatform.isLinux [
            webkitgtk_4_1
            gtk3
            libsoup_3
            openssl
          ];

          shellHook = ''
            ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
              export ${cargoLinkerVar}=${appleLinker}
            ''}
            ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              # GTK3 aborts on the first file dialog without its GSettings
              # schemas ("org.gtk.Settings.FileChooser is not installed").
              export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}
            ''}
            echo "monocode: node $(node -v), $(rustc --version)"
          '';
        };
      });
    };
}

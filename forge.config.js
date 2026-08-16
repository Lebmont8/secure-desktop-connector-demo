const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "secure-connector-demo",
    appBundleId: "dev.lebmont.secure-connector-demo",
    appCategoryType: "public.app-category.developer-tools",
    win32metadata: {
      CompanyName: "Lebmont8",
      FileDescription: "Secure Desktop Connector Demo",
      InternalName: "SecureConnectorDemo",
      OriginalFilename: "secure-connector-demo.exe",
      ProductName: "Secure Desktop Connector Demo"
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "SecureConnectorDemo",
        title: "Secure Desktop Connector Demo",
        exe: "secure-connector-demo.exe",
        setupExe: "Secure-Desktop-Connector-Demo-Setup.exe",
        noMsi: true,
        authors: "Lebmont8",
        description: "Mock-only secure desktop connector demo"
      }
    },
    { name: "@electron-forge/maker-zip", platforms: ["darwin"], config: {} },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "secure-desktop-connector-demo",
          productName: "Secure Desktop Connector Demo",
          genericName: "Developer tool",
          description: "Mock-only secure desktop connector demo",
          maintainer: "Lebmont8",
          section: "utils",
          priority: "optional",
          categories: ["Development"],
          bin: "secure-connector-demo"
        }
      }
    }
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true
    })
  ]
};

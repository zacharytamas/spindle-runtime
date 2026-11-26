Biome cannot lint a package.json that is not JSON, so the tests copy this fixture to a temporary directory and write `{` to `agents/packed/sample/package.json` there.

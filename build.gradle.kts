tasks.register("buildUiautomatorJar") {
  group = "build"
  description = "Builds the Android UIAutomator server jar."
  dependsOn(":android-server:buildUiautomatorJar")
}

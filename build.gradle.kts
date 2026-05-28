import org.gradle.api.tasks.Delete

tasks.register("buildUiautomatorJar") {
  group = "build"
  description = "Builds the Android UIAutomator server jar."
  dependsOn(":android-server:buildUiautomatorJar")
}

tasks.register<Delete>("clean") {
  group = "build"
  description = "Deletes build directories for all projects."
  delete(layout.buildDirectory)
  dependsOn(":android-server:clean")
}

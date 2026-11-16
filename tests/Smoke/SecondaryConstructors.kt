import constructorfixture.WithPrimary
import constructorfixture.OnlySecondary
import constructorfixture.GenericSecondary
import System.DateTime
import System.Net.Http.StringContent
import System.Text.Encoding

fun clrConstructorProbe() {
    val date: DateTime = DateTime(2026, 11, 12, 13, 14, 15)
    val content: StringContent = StringContent("{}", Encoding.UTF8, "application/json")
}

fun secondaryConstructorProbe() {
    val primary: Int = WithPrimary(1).value
    val secondary: Int = WithPrimary("10", 2).value
    val defaultArgument: Int = WithPrimary("10").value
    val namedArguments: Int = WithPrimary(text = "10", radix = 2).value
    val otherSecondary: Int = WithPrimary(true).value
    val onlySecondary: Int = OnlySecondary(1).value
    val onlySecondaryText: Int = OnlySecondary("10").value
    val genericSecondary: String = GenericSecondary(listOf("value")).value
}

import System.DayOfWeek
import System.Text.Encoding
import System.Text.Rune
import System.Text.UTF8Encoding

fun utf8ByteCount(text: String): Int = Encoding.UTF8.GetByteCount(text)

fun runeValue(value: Int): Int = Rune(value).Value

fun utf8WebName(): String = UTF8Encoding().WebName

fun cloneableEncoding(): System.ICloneable = Encoding.UTF8

// CLR enum constants and equality must resolve through the reference KLIB.
fun isWeekend(day: DayOfWeek): Boolean = day == DayOfWeek.Saturday || day == DayOfWeek.Sunday

fun <T> appendValues(
    builder: System.Text.StringBuilder,
    values: System.Collections.Generic.IEnumerable<T>,
): System.Text.StringBuilder = builder.AppendJoin(',', values)

fun firstUnsigned(values: UIntArray): UInt = values[0]
